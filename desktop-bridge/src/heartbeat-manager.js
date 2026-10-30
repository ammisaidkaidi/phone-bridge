// src/heartbeat-manager.js
// 10s heartbeat to the devices table. Mirror of Android's HeartbeatManager.

'use strict';

const os = require('os');
const sm = require('./supabase-manager');
const HEARTBEAT_INTERVAL_MS = 10_000;

class HeartbeatManager {
  constructor({ client, getCurrentlyExecuting, onLog }) {
    this.client = client;
    this.getCurrentlyExecuting = getCurrentlyExecuting || (() => null);
    this.onLog = onLog || ((m) => console.log(m));
    this.sessionId = require('crypto').randomUUID();
    this._timer = null;
    this._running = false;
  }
  getSessionId() { return this.sessionId; }
  start() {
    if (this._running) return;
    this._running = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), HEARTBEAT_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    this.onLog(`Heartbeat started (every 10s, session=${this.sessionId.slice(0, 8)})`, 'info');
  }
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._sendOne({ alive: false }).catch(() => {});
    this.onLog('Heartbeat stopped', 'info');
  }
  forceHeartbeat() { return this._tick(); }
  async _tick() {
    if (!this._running) return;
    try { await this._sendOne({ alive: true }); }
    catch (e) { this.onLog(`Heartbeat failed: ${e.message}`, 'warn'); }
  }
  async _sendOne(extra) {
    const body = Object.assign({
      device_id: sm.getDeviceId(),
      name: sm.getDeviceName(),
      model: os.hostname(),
      manufacturer: 'Windows',
      product: process.platform,
      device_codename: process.arch,
      android_version: os.release(),
      sdk_int: Number(os.release().split('.')[0]) || 0,
      privilege_level: 'app',
      shizuku_uid: -1,
      session_id: this.sessionId,
      currently_executing_id: this.getCurrentlyExecuting(),
    }, extra || {});
    const { status, body: resp } = await this.client.heartbeat(body);
    if (status >= 400) throw new Error(`HTTP ${status} — ${JSON.stringify(resp)}`);
    return resp;
  }
}

module.exports = { HeartbeatManager };
