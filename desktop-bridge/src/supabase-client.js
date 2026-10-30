// src/supabase-client.js
//
// HTTP + WebSocket client for the Supabase edge functions + realtime API.
// Uses Node's built-in `https` module + the `ws` npm package for
// WebSocket (Electron 33 ships Node 20 which doesn't have global WebSocket).

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_MS = 150_000;

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const method = (opts.method || 'GET').toUpperCase();
    // Handle 3 body types: string, Buffer (binary), or object (JSON).
    // The Buffer case is critical for multipart/form-data uploads (edge
    // function deploy) — JSON.stringify on a Buffer produces garbage.
    let body = null;
    if (opts.body != null) {
      if (typeof opts.body === 'string') body = opts.body;
      else if (Buffer.isBuffer(opts.body)) body = opts.body;
      else body = JSON.stringify(opts.body);
    }
    const headers = Object.assign({}, opts.headers || {});
    if (body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (body != null && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
    const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout after ' + timeout + 'ms')));
    if (body != null) req.write(body);
    req.end();
  });
}

class SupabaseClient {
  constructor({ projectUrl, publishableKey }) {
    if (!projectUrl) throw new Error('projectUrl required');
    if (!publishableKey) throw new Error('publishableKey required');
    this.projectUrl = projectUrl.replace(/\/+$/, '');
    this.publishableKey = publishableKey;
    this.fnBase = this.projectUrl + '/functions/v1/';
    this.wsUrl = this.projectUrl.replace(/^http/, 'ws') + '/realtime/v1/websocket';
  }

  _headers(extra) {
    return Object.assign({
      'apikey': this.publishableKey,
      'Authorization': 'Bearer ' + this.publishableKey,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  async _call(slug, { method = 'GET', query, body, timeoutMs } = {}) {
    let url = this.fnBase + slug;
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v != null) qs.set(k, String(v));
      const s = qs.toString(); if (s) url += '?' + s;
    }
    const opts = { method, headers: this._headers(), timeoutMs };
    if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    const { status, body: respBody } = await fetch(url, opts);
    let parsed = null;
    try { parsed = JSON.parse(respBody); } catch (_) { parsed = respBody; }
    return { status, body: parsed, raw: respBody };
  }

  // ---- Phone bridge endpoints ----
  async sendCommand({ command, args = {}, deviceId } = {}) {
    const body = { command, args }; if (deviceId) body.device_id = deviceId;
    return this._call('send-command', { method: 'POST', body });
  }
  async getResult(id) { return this._call('get-result', { method: 'GET', query: { id } }); }
  async listCommands({ status, limit = 30 } = {}) {
    return this._call('list-commands', { method: 'GET', query: { status, limit } });
  }
  async updateResult(body) { return this._call('update-result', { method: 'POST', body }); }
  async deleteCommand(id) { return this._call('delete-command', { method: 'POST', body: { id } }); }
  async clearCommands() { return this._call('clear-commands', { method: 'POST', body: {} }); }
  async listDevices() { return this._call('list-devices', { method: 'GET' }); }
  async listFunctions() { return this._call('list-functions', { method: 'GET' }); }
  async listModules() { return this._call('list-modules', { method: 'GET' }); }
  async uploadModule(body) { return this._call('upload-module', { method: 'POST', body }); }
  async getAgentPrompt() { return this._call('agent-prompt', { method: 'GET' }); }
  async heartbeat(body) { return this._call('heartbeat', { method: 'POST', body }); }
  async recoverStale() { return this._call('recover-stale', { method: 'POST', body: {} }); }

  // ---- File storage ----
  async uploadFile({ path: filePath, name } = {}) {
    // Uploads to the phone-files bucket. Uses multipart/form-data.
    const fs = require('fs');
    const stats = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    const filename = name || require('path').basename(filePath);
    const boundary = '----pb' + Math.random().toString(16).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      buf,
      `\r\n--${boundary}--\r\n`,
    ];
    const bodyBuf = Buffer.concat(parts.map((p) => Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8')));
    const url = this.projectUrl + '/storage/v1/object/phone-files/ai-uploads/' + filename;
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign(this._headers(), {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': bodyBuf.length,
        'x-upsert': 'true',
      }),
      body: bodyBuf,
    });
    return { status: resp.status, body: resp.body };
  }
  async listFiles() { return this._call('list-files', { method: 'GET' }); }
  async deleteFile(paths) { return this._call('delete-file', { method: 'POST', body: { paths } }); }

  // ---- Knowledge + skills ----
  async knowledgeSync() { return this._call('knowledge-sync', { method: 'GET' }); }
  async knowledgePull(id) { return this._call('knowledge-pull', { method: 'GET', query: { id } }); }
  async knowledgeDelete(id) { return this._call('knowledge-delete', { method: 'POST', body: { id } }); }
  async skillsSync() { return this._call('skills-sync', { method: 'GET' }); }
  async skillsPull(id) { return this._call('skills-pull', { method: 'GET', query: { id } }); }
  async skillsDelete(id) { return this._call('skills-delete', { method: 'POST', body: { id } }); }

  // ---- Agent chat ----
  async agentRegister(body) { return this._call('agent-register', { method: 'POST', body }); }
  async agentHeartbeat(body) { return this._call('agent-heartbeat', { method: 'POST', body }); }
  async agentList() { return this._call('agent-list', { method: 'GET' }); }
  async chatCreate(body) { return this._call('chat-create', { method: 'POST', body }); }
  async chatList(agentId) { return this._call('chat-list', { method: 'GET', query: { agent_id: agentId } }); }
  async chatSend(body) { return this._call('chat-send', { method: 'POST', body }); }
  async chatGetAll({ chatId, kind, sinceId, limit = 200 }) {
    const query = { chat_id: chatId, limit }; if (kind) query.kind = kind;
    if (sinceId != null) query.since_id = sinceId;
    return this._call('chat-get-all', { method: 'GET', query });
  }
  async chatWaitForAsk(body) {
    return this._call('chat-wait-for-ask', { method: 'POST', body, timeoutMs: LONG_POLL_TIMEOUT_MS });
  }
  async chatWaitForResult(body) {
    return this._call('chat-wait-for-result', { method: 'POST', body, timeoutMs: LONG_POLL_TIMEOUT_MS });
  }
  async chatAck(messageId) { return this._call('chat-ack', { method: 'POST', body: { message_id: messageId } }); }
  async chatAsk(body) {
    return this._call('chat-ask', { method: 'POST', body, timeoutMs: LONG_POLL_TIMEOUT_MS });
  }

  // ---- Realtime WebSocket ----
  connectRealtime({ onOpen, onCommandInsert, onStatusUpdate, onError, onClose }) {
    const url = `${this.wsUrl}?apikey=${encodeURIComponent(this.publishableKey)}&vsn=1.0.0`;
    // Use the `ws` npm package — Electron 33's Node 20 doesn't have
    // a global WebSocket. The `ws` API uses EventEmitter-style listeners
    // (ws.on('open', cb)) instead of browser-style (ws.onopen = cb).
    const ws = new WebSocket(url);
    ws.on('open', () => {
      const joinMsg = {
        topic: 'realtime:public:commands',
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: '' },
            postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'commands' }],
          },
        },
        ref: '1',
      };
      ws.send(JSON.stringify(joinMsg));
      if (onOpen) onOpen();
    });
    ws.on('message', (data) => {
      // `ws` package passes the raw message as a Buffer/string, not an event.
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'postgres_changes' && msg.payload && msg.payload.data) {
          const record = msg.payload.data.record;
          if (record && msg.payload.data.type === 'INSERT') {
            if (onCommandInsert) onCommandInsert(record);
          } else if (record && msg.payload.data.type === 'UPDATE') {
            if (onStatusUpdate) onStatusUpdate(record);
          }
        }
      } catch (_) {}
    });
    ws.on('error', (e) => { if (onError) onError(e); });
    ws.on('close', () => { if (onClose) onClose(); });
    const hbTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(Date.now()) }));
      }
    }, 25_000);
    return {
      ws,
      close: () => { clearInterval(hbTimer); try { ws.close(); } catch (_) {} },
      isOpen: () => ws.readyState === WebSocket.OPEN,
    };
  }
}

module.exports = { SupabaseClient, fetch };
