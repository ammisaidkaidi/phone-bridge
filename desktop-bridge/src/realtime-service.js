// src/realtime-service.js
// WebSocket listener + watchdog + backlog recovery.
// Mirror of Android's RealtimeService.java (minus the foreground service).

'use strict';

const sm = require('./supabase-manager');
const MAX_BACKOFF_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 15_000;

class RealtimeService {
  constructor({ client, executor, heartbeat, onStatus, onLog }) {
    this.client = client;
    this.executor = executor;
    this.heartbeat = heartbeat;
    this.onStatus = onStatus || ((s) => console.log('realtime:', s));
    this.onLog = onLog || ((m, l) => console.log(`[${l}] ${m}`));
    this._connection = null;
    this._backoffMs = 1000;
    this._watchdogTimer = null;
    this._reconnectTimer = null;    // track pending reconnect to prevent double-scheduling
    this._reconnectPending = false; // guard: only one reconnect in flight
    this._running = false;
  }
  start() {
    if (this._running) return;
    this._running = true;
    if (this.heartbeat) this.heartbeat.start();
    this._connect();
    this._startWatchdog();
    this.onLog('RealtimeService started', 'info');
  }
  stop() {
    this._running = false;
    if (this._connection) { this._connection.close(); this._connection = null; }
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectPending = false;
    if (this.heartbeat) this.heartbeat.stop();
    this.onStatus('disconnected');
    this.onLog('RealtimeService stopped', 'info');
  }
  isConnected() { return this._connection && this._connection.isOpen(); }

  _startWatchdog() {
    this._watchdogTimer = setInterval(() => {
      if (!this._running) return;
      if (!this.isConnected()) {
        this.onLog('Watchdog: WebSocket not connected — forcing reconnect', 'warn');
        this._connect();
      }
    }, WATCHDOG_INTERVAL_MS);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }
  _connect() {
    if (!this._running) return;
    if (!sm.isConfigured()) {
      this.onLog('RealtimeService: not configured — skipping connect', 'warn'); return;
    }
    this.onStatus('connecting');
    if (this._connection) { try { this._connection.close(); } catch (_) {} this._connection = null; }
    try {
      this._connection = this.client.connectRealtime({
        onOpen: () => {
          this._backoffMs = 1000;
          this.onStatus('connected');
          this.onLog('Realtime connected', 'info');
          this._recoverPendingCommands();
        },
        onCommandInsert: (record) => {
          this.executor.handle(record).catch((e) => this.onLog(`exec failed for #${record.id}: ${e.message}`, 'error'));
        },
        onStatusUpdate: () => {},
        onError: (e) => { this.onLog(`Realtime error: ${e.message || e}`, 'warn'); this._scheduleReconnect(); },
        onClose: () => { this.onStatus('disconnected'); this.onLog('Realtime closed', 'info'); this._scheduleReconnect(); },
      });
    } catch (e) {
      this.onLog(`Realtime connect failed: ${e.message}`, 'error');
      this._scheduleReconnect();
    }
  }
  _scheduleReconnect() {
    if (!this._running) return;
    // GUARD: if both onError AND onClose fire (common with the `ws`
    // package), prevent double-scheduling. Only one reconnect in flight.
    if (this._reconnectPending) return;
    this._reconnectPending = true;
    // Clear any previously-scheduled reconnect timer.
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    const delay = this._backoffMs;
    this.onLog(`Scheduling reconnect in ${delay}ms`, 'info');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectPending = false;
      if (this._running) this._connect();
    }, delay);
    this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);
  }
  async _recoverPendingCommands() {
    try {
      const myDeviceId = sm.getDeviceId();
      const { status, body } = await this.client.listCommands({ status: 'pending', limit: 50 });
      if (status >= 400) { this.onLog(`recoverPending: HTTP ${status}`, 'warn'); return; }
      const cmds = (body && body.commands) || [];
      if (cmds.length === 0) { this.onLog('recoverPending: no pending commands', 'info'); return; }
      let recovered = 0;
      for (const record of cmds) {
        const target = record.device_id;
        if (target && target !== 'null' && target !== myDeviceId) continue;
        if (Number(record.id) < 0) continue;
        this.onLog(`recoverPending: processing #${record.id}`, 'info');
        this.executor.handle(record).catch((e) => this.onLog(`recoverPending #${record.id} failed: ${e.message}`, 'warn'));
        recovered++;
      }
      this.onLog(`recoverPending: recovered ${recovered} pending command(s)`, 'info');
    } catch (e) { this.onLog(`recoverPendingCommands failed: ${e.message}`, 'warn'); }
  }
}

module.exports = { RealtimeService };
