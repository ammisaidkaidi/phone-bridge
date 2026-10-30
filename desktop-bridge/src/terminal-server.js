// src/terminal-server.js
// Local HTTP API on 127.0.0.1:8080. Mirror of Android's TerminalServer.java.
// Endpoints: /execute /input /acks /state /result /kill /
// Commands run via cmd.exe /c on Windows (sh -c on Linux/Mac).

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const MAX_CONSUMED_WAIT_MS = 5000;
const isWindows = process.platform === 'win32';
const SHELL = isWindows ? 'cmd.exe' : 'sh';
const SHELL_FLAG = isWindows ? '/c' : '-c';

class Record {
  constructor(id, req, reqTime) {
    this.id = id; this.req = req; this.reqTime = reqTime;
    this.respStartTime = null; this.resp = ''; this.resEndTime = null;
    this.error = null; this.status = 'pending'; this.exitCode = null;
    this.pid = null; this.inputs = 0; this.acks = [];
    this.inQueue = []; this.nextSeq = 0;
    this.ackResolvers = new Map(); this.stop = false; this.process = null;
  }
}

const MAX_STORE_RECORDS = 50;       // cap: delete oldest when exceeded
const MAX_RESP_BYTES = 1024 * 1024; // 1MB cap per record's resp string

class TerminalServer {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, onLog } = {}) {
    this.host = host; this.port = port;
    this.onLog = onLog || ((m) => console.log(m));
    this.store = new Map();
    this.server = null; this.actualPort = -1;
  }

  /** Trim the store to MAX_STORE_RECORDS (delete oldest by insertion order). */
  _trimStore() {
    if (this.store.size <= MAX_STORE_RECORDS) return;
    // Map preserves insertion order — delete the first entries.
    const toDelete = this.store.size - MAX_STORE_RECORDS;
    let i = 0;
    for (const key of this.store.keys()) {
      if (i >= toDelete) break;
      const rec = this.store.get(key);
      if (rec.process) { try { rec.process.kill('SIGTERM'); } catch (_) {} }
      this.store.delete(key);
      i++;
    }
  }

  /** Cap a record's resp string to MAX_RESP_BYTES to prevent unbounded
   *  growth from commands that produce huge output (e.g. `dir /s`). */
  _capResp(rec) {
    if (rec.resp.length > MAX_RESP_BYTES) {
      // Keep the last 512KB (most recent output) + a truncation notice.
      const keep = MAX_RESP_BYTES / 2;
      rec.resp = '…[truncated — first ' + (rec.resp.length - keep) + ' chars removed]\n'
        + rec.resp.slice(-keep);
    }
  }
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.actualPort = this.server.address().port;
        this.onLog(`TerminalServer listening on http://${this.host}:${this.actualPort}`, 'info');
        resolve(this.actualPort);
      });
    });
  }
  stop() {
    if (!this.server) return;
    for (const rec of this.store.values()) {
      rec.stop = true;
      if (rec.process) { try { rec.process.kill('SIGTERM'); } catch (_) {} }
      for (const resolve of rec.ackResolvers.values()) resolve({ status: 'released' });
    }
    this.store.clear();
    this.server.close(); this.server = null;
    this.onLog('TerminalServer stopped', 'info');
  }
  isRunning() { return this.server != null; }
  getPort() { return this.actualPort; }

  async _handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const method = req.method;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      let bodyStr = '';
      if (method === 'POST') {
        bodyStr = await new Promise((resolve) => {
          let buf = ''; req.on('data', (c) => buf += c); req.on('end', () => resolve(buf));
        });
      }
      if (method === 'GET') return this._handleGet(res, path, query);
      if (method === 'POST') return this._handlePost(res, path, query, bodyStr);
      this._sendJson(res, 405, { error: 'method not allowed' });
    } catch (e) { this._sendJson(res, 500, { error: e.message }); }
  }
  _handleGet(res, path, query) {
    if (path === '/' || path === '/health') {
      return this._sendJson(res, 200, {
        service: 'terminal-http-api (node)',
        endpoints: {
          'POST /execute': '{cmd:...}',
          'POST /input?id=<id>': '{data:...,mode:delivered|consumed}',
          'GET /acks?id=<id>': 'acks',
          'GET /state': 'all commands',
          'GET /result?id=<id>': 'single record',
          'POST /kill?id=<id>': 'kill',
        },
        commands_tracked: this.store.size,
      });
    }
    if (path === '/state') return this._sendJson(res, 200, [...this.store.values()].map((r) => this._publicRecord(r)));
    if (path === '/result') {
      const id = query.id; if (!id) return this._sendJson(res, 400, { error: 'missing ?id=' });
      const r = this.store.get(id); if (!r) return this._sendJson(res, 404, { error: 'no such id' });
      return this._sendJson(res, 200, this._publicRecord(r));
    }
    if (path === '/acks') {
      const id = query.id; if (!id) return this._sendJson(res, 400, { error: 'missing ?id=' });
      const r = this.store.get(id); if (!r) return this._sendJson(res, 404, { error: 'no such id' });
      return this._sendJson(res, 200, r.acks);
    }
    this._sendJson(res, 404, { error: 'unknown path: ' + path });
  }
  _handlePost(res, path, query, bodyStr) {
    if (path === '/execute') {
      let j; try { j = JSON.parse(bodyStr); } catch (_) { return this._sendJson(res, 400, { error: 'invalid JSON body' }); }
      const cmd = j && j.cmd; if (typeof cmd !== 'string' || !cmd) return this._sendJson(res, 400, { error: 'body must contain {cmd:<string>}' });
      const id = crypto.randomUUID().replace(/-/g, '');
      const t = new Date().toISOString();
      const rec = new Record(id, cmd, t);
      this.store.set(id, rec);
      this._trimStore();
      this._runCommand(rec);
      return this._sendJson(res, 202, { id, reqTime: t, req: cmd });
    }
    if (path === '/input') {
      const id = query.id; if (!id) return this._sendJson(res, 400, { error: 'missing ?id=' });
      const rec = this.store.get(id); if (!rec) return this._sendJson(res, 404, { error: 'no such id' });
      let j; try { j = JSON.parse(bodyStr); } catch (_) { return this._sendJson(res, 400, { error: 'invalid JSON body' }); }
      let payload;
      if (j && typeof j.b64 === 'string') payload = Buffer.from(j.b64, 'base64');
      else if (j && typeof j.data === 'string') payload = Buffer.from(j.data, 'utf8');
      else return this._sendJson(res, 400, { error: 'body must contain {data} or {b64}' });
      const mode = (j && j.mode) ? String(j.mode) : 'delivered';
      if (mode !== 'delivered' && mode !== 'consumed') return this._sendJson(res, 400, { error: 'mode must be delivered or consumed' });
      return this._queueInput(rec, payload, mode).then((ack) => this._sendJson(res, 200, ack));
    }
    if (path === '/kill') {
      const id = query.id; if (!id) return this._sendJson(res, 400, { error: 'missing ?id=' });
      const rec = this.store.get(id);
      if (!rec) return this._sendJson(res, 400, { ok: false, message: 'no such id' });
      if (rec.status !== 'running') return this._sendJson(res, 400, { ok: false, message: 'not running' });
      if (!rec.process) return this._sendJson(res, 400, { ok: false, message: 'no process' });
      try { rec.process.kill('SIGTERM'); rec.status = 'killed'; rec.resEndTime = new Date().toISOString();
            return this._sendJson(res, 200, { ok: true, message: 'SIGTERM sent' }); }
      catch (_) { return this._sendJson(res, 400, { ok: false, message: 'destroy failed' }); }
    }
    this._sendJson(res, 404, { error: 'unknown path: ' + path });
  }
  _sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  _publicRecord(r) {
    return {
      id: r.id, reqTime: r.reqTime, req: r.req, respStartTime: r.respStartTime,
      resp: r.resp, resEndTime: r.resEndTime, error: r.error, status: r.status,
      exitCode: r.exitCode, pid: r.pid, inputs: r.inputs, acks: r.acks,
    };
  }
  _runCommand(rec) {
    rec.respStartTime = new Date().toISOString();
    rec.status = 'running';
    try {
      const child = spawn(SHELL, [SHELL_FLAG, rec.req], { windowsHide: true });
      rec.process = child; rec.pid = child.pid;
      this._writerLoop(rec);
      child.stdout.on('data', (d) => { rec.resp += d.toString('utf8'); this._capResp(rec); });
      child.stderr.on('data', (d) => { rec.resp += d.toString('utf8'); this._capResp(rec); });
      child.on('close', (code) => {
        rec.exitCode = code; rec.resEndTime = new Date().toISOString();
        rec.status = (code === 0) ? 'completed' : 'failed';
        rec.stop = true;
        for (const resolve of rec.ackResolvers.values()) resolve({ status: 'released' });
        rec.ackResolvers.clear();
      });
    } catch (e) {
      rec.error = e.message; rec.status = 'failed';
      rec.resEndTime = new Date().toISOString();
    }
  }
  async _writerLoop(rec) {
    const stdin = rec.process.stdin;
    while (!rec.stop) {
      const item = rec.inQueue.shift();
      if (!item) { await new Promise((r) => setTimeout(r, 100)); continue; }
      if (item.seq === -1) break;
      const ack = { seq: item.seq, startedAt: item.startedAt, mode: item.mode, status: 'pending', bytesWritten: 0, error: null };
      try {
        if (rec.process.killed || rec.process.exitCode != null) {
          ack.status = 'rejected'; ack.error = 'process already exited';
        } else {
          stdin.write(item.data); ack.bytesWritten = item.data.length;
          if (item.mode === 'consumed') {
            const before = rec.resp.length;
            const deadline = Date.now() + MAX_CONSUMED_WAIT_MS;
            while (Date.now() < deadline) {
              if (rec.process.killed || rec.process.exitCode != null) break;
              if (rec.resp.length > before) break;
              await new Promise((r) => setTimeout(r, 50));
            }
            ack.status = rec.resp.length > before ? 'consumed' : 'timeout';
          } else { ack.status = 'delivered'; }
        }
      } catch (e) { ack.status = 'failed'; ack.error = e.message; }
      ack.ackedAt = new Date().toISOString();
      rec.acks.push(ack);
      const resolve = rec.ackResolvers.get(item.seq);
      if (resolve) { rec.ackResolvers.delete(item.seq); resolve(ack); }
    }
    try { stdin.end(); } catch (_) {}
  }
  async _queueInput(rec, payload, mode) {
    const seq = rec.nextSeq++;
    rec.inputs++;
    const startedAt = new Date().toISOString();
    const item = { seq, data: payload, mode, startedAt };
    let resolveAck;
    const ackPromise = new Promise((r) => { resolveAck = r; });
    rec.ackResolvers.set(seq, resolveAck);
    rec.inQueue.push(item);
    try {
      const ack = await Promise.race([
        ackPromise,
        new Promise((r) => setTimeout(() => r(null), 60_000)),
      ]);
      if (ack) return ack;
      return { seq, startedAt, mode, status: 'timeout', bytesWritten: 0, error: 'no ack within 60s', ackedAt: new Date().toISOString() };
    } catch (e) {
      return { seq, startedAt, mode, status: 'failed', bytesWritten: 0, error: e.message, ackedAt: new Date().toISOString() };
    }
  }
}

module.exports = { TerminalServer };
