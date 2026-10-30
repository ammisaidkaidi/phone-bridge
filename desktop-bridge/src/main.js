// src/main.js
// Electron main process. Creates the BrowserWindow with 6 tabs
// (Bridge + Terminal + Configure + Permissions + Modules + Knowledge),
// hosts the system tray icon, manages the RealtimeService +
// TerminalServer + HeartbeatManager + KnowledgeManager + ModuleManager
// lifecycle, and registers IPC handlers.

'use strict';

// MUST be the very first thing — expose GC before V8 finishes initializing.
// v8.setFlagsFromString works even in packaged apps (unlike --js-flags CLI
// arg which only works in dev mode via npm start). This + the --js-flags
// arg in package.json scripts covers both dev + packaged scenarios.
try { require('v8').setFlagsFromString('--expose-gc'); } catch (_) {}

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const sm = require('./supabase-manager');
const config = require('./config-store');
const perms = require('./permission-manager');
const { SupabaseClient } = require('./supabase-client');
const { CommandExecutor } = require('./command-executor');
const { HeartbeatManager } = require('./heartbeat-manager');
const { RealtimeService } = require('./realtime-service');
const { TerminalServer } = require('./terminal-server');
const { KnowledgeManager } = require('./knowledge-manager');
const { ModuleManager } = require('./module-manager');

let mainWindow = null;
let tray = null;
let bridge = null;            // { client, executor, heartbeat, realtime, knowledge, skills, modules }
let terminalServer = null;

// ============================ Tray icon ============================
function trayIconDataURL(color) {
  const hex = { green: '#10B981', amber: '#F59E0B', red: '#EF4444' }[color] || '#9CA3AF';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="${hex}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
function updateTrayIcon(status) {
  if (!tray) return;
  const m = { connected: 'green', connecting: 'amber', disconnected: 'red' };
  tray.setImage(nativeImage.createFromDataURL(trayIconDataURL(m[status] || 'red')));
  tray.setToolTip(`Phone Bridge Desktop — ${status}`);
}
function buildTray() {
  tray = new Tray(nativeImage.createFromDataURL(trayIconDataURL('red')));
  tray.setToolTip('Phone Bridge Desktop');
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
  rebuildTrayMenu();
}
function rebuildTrayMenu() {
  if (!tray) return;
  const isConnected = !!(bridge && bridge.realtime && bridge.realtime.isConnected());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show window', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Hide window', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    { label: isConnected ? 'Status: connected' : 'Status: disconnected', enabled: false },
    { label: 'Disconnect', click: () => doDisconnect(), enabled: !!bridge },
    { label: 'Reconnect', click: () => { if (bridge) { bridge.realtime.stop(); setTimeout(() => bridge.realtime.start(), 200); } }, enabled: !!bridge },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ============================ Window ============================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#0F172A',
    title: 'Phone Bridge Desktop',
    autoHideMenuBar: true,   // hide the native menu bar (File/Edit/View/...)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault(); mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({ title: 'Phone Bridge Desktop', body: 'Still running in the system tray. Click the tray icon to quit.' }).show();
      }
    }
  });
}

// ============================ Bridge lifecycle ============================
function doConnect() {
  if (!sm.isConfigured()) { logToRenderer('Not configured — defaults should work out of the box', 'error'); return; }
  if (bridge) { logToRenderer('Already connected — disconnect first', 'warn'); return; }
  const client = new SupabaseClient({
    projectUrl: sm.getProjectUrl(),
    publishableKey: sm.getPublishableKey(),
  });
  // Knowledge removed — only skills manager is used now.
  const skills    = new KnowledgeManager({ client, kind: 'skills',    onLog: (m, l) => logToRenderer(m, l) });
  const modules   = new ModuleManager({ client, onLog: (m, l) => logToRenderer(m, l) });
  const executor = new CommandExecutor({
    client, heartbeat: null, knowledge: null, skills, modules,
    onLog: (m, l) => logToRenderer(m, l),
  });
  const heartbeat = new HeartbeatManager({
    client,
    getCurrentlyExecuting: () => executor.getCurrentlyExecuting(),
    onLog: (m, l) => logToRenderer(m, l),
  });
  executor.heartbeat = heartbeat;
  const realtime = new RealtimeService({
    client, executor, heartbeat,
    onStatus: (s) => {
      updateTrayIcon(s);
      if (mainWindow) mainWindow.webContents.send('bridge:status', s);
      rebuildTrayMenu();
    },
    onLog: (m, l) => logToRenderer(m, l),
  });
  bridge = { client, executor, heartbeat, realtime, skills, modules };
  config.set('bridgeWasConnected', true);
  realtime.start();
  skills.startPeriodicSync();
  logToRenderer('Bridge started — connecting via realtime WebSocket…', 'info');
}

function doDisconnect() {
  if (!bridge) return;
  bridge.skills.stopPeriodicSync();
  bridge.realtime.stop();
  bridge = null;
  config.set('bridgeWasConnected', false);
  updateTrayIcon('disconnected');
  rebuildTrayMenu();
  if (mainWindow) mainWindow.webContents.send('bridge:status', 'disconnected');
  logToRenderer('Bridge stopped', 'info');
}

function logToRenderer(msg, level) {
  if (mainWindow) mainWindow.webContents.send('log', { msg, level: level || 'info', ts: Date.now() });
}

// ============================ Terminal server ============================
async function startTerminalServer() {
  if (terminalServer) return terminalServer.getPort();
  const port = config.get('terminalPort') || 0;
  terminalServer = new TerminalServer({ port, onLog: (m, l) => logToRenderer(m, l) });
  try { return await terminalServer.start(); }
  catch (e) { terminalServer = null; throw e; }
}
function stopTerminalServer() {
  if (terminalServer) { terminalServer.stop(); terminalServer = null; }
}

// ============================ App lifecycle ============================
// GC was exposed at the top of this file via v8.setFlagsFromString('--expose-gc').
// No need for app.commandLine.appendSwitch (which is too late — V8 has
// already initialized by the time the app module loads).

app.whenReady().then(() => {
  // Hide the built-in menu bar (File / Edit / View / Window / Help).
  Menu.setApplicationMenu(null);
  createWindow();
  buildTray();
  if (Notification.isSupported() && process.platform === 'win32') {
    try { app.setAppUserModelId('com.example.portscanner.desktopbridge'); } catch (_) {}
  }
  if (config.get('bridgeWasConnected') && sm.isConfigured()) {
    setTimeout(() => doConnect(), 500);
  }
  // Periodic GC every 60s — forces V8 to collect accumulated old-space
  // objects (HTTP response buffers, WebSocket frames, JSON parse trees)
  // that would otherwise linger for minutes before natural GC.
  const gc = global.gc;
  if (typeof gc === 'function') {
    setInterval(() => { try { gc(); } catch (_) {} }, 60_000);
    console.log('Periodic GC enabled (every 60s)');
  } else {
    console.warn('gc not exposed — run electron with --js-flags="--expose-gc"');
  }
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow) mainWindow.show();
});

// ============================ IPC handlers ============================
ipcMain.handle('config:get', () => config.all());
ipcMain.handle('config:set', (_e, p) => { config.patch(p); return config.all(); });

ipcMain.handle('setup:run', async (_e, pat) => {
  try {
    const result = await sm.setup(pat || config.get('personalAccessToken'));
    logToRenderer(result.message, 'info');
    return { ok: true, result };
  } catch (e) {
    logToRenderer('Setup failed: ' + e.message, 'error');
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('setup:redeploy-fns', async () => {
  try {
    const pat = config.get('personalAccessToken');
    const ref = sm.getProjectRef();
    if (!pat || !ref) throw new Error('Not configured yet');
    await sm.deployEdgeFunctions(pat, ref);
    logToRenderer('Redeployed all 34 edge functions', 'info');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('setup:copy-sql', async () => sm.SCHEMA_SQL);

ipcMain.handle('bridge:connect', async () => { doConnect(); return { ok: true }; });
ipcMain.handle('bridge:disconnect', async () => { doDisconnect(); return { ok: true }; });
ipcMain.handle('bridge:status', async () => ({
  connected: !!(bridge && bridge.realtime && bridge.realtime.isConnected()),
  configured: sm.isConfigured(),
}));

ipcMain.handle('commands:list', async (_e, { status, limit } = {}) => {
  if (!bridge) return { commands: [], count: 0 };
  return bridge.client.listCommands({ status, limit: limit || 30 });
});
ipcMain.handle('commands:clear', async () => bridge ? bridge.client.clearCommands() : { ok: false });
ipcMain.handle('commands:delete', async (_e, id) => bridge ? bridge.client.deleteCommand(id) : { ok: false });
ipcMain.handle('commands:mark', async (_e, { id, status, result, error }) => {
  if (!bridge) return { ok: false };
  const body = { id, status };
  if (result != null) body.result = result;
  if (error != null) body.error = error;
  return bridge.client.updateResult(body);
});

ipcMain.handle('test:ping', async () => bridge ? bridge.client.sendCommand({ command: 'ping', args: {} }) : { ok: false });
ipcMain.handle('devices:list', async () => bridge ? bridge.client.listDevices() : { devices: [] });
ipcMain.handle('functions:list', async () => bridge ? bridge.client.listFunctions() : { functions: [] });
ipcMain.handle('ai-prompt:get', async () => {
  // Returns ONLY the short "fetch + apply" instruction — the full prompt
  // lives on the agent-prompt edge function (server-side, updateable
  // without rebuilding the app). The user pastes this short blurb into
  // their AI agent; the agent fetches the full briefing at startup.
  const url = sm.getProjectUrl();
  const key = sm.getPublishableKey();
  if (!url || !key) return '';
  const promptUrl = url + '/functions/v1/agent-prompt';
  return `Read the full system prompt from this URL and apply it:\n  ${promptUrl}\nHeaders required for the request:\n  Authorization: Bearer ${key}\n  apikey: ${key}`;
});

// Permissions tab
ipcMain.handle('perms:get-all', async () => perms.getAll());
ipcMain.handle('perms:set', async (_e, { command, decision }) => {
  perms.setDecision(command, decision);
  return { ok: true };
});

// Modules tab
ipcMain.handle('modules:list', async () => {
  if (!bridge) return { modules: [] };
  return { modules: bridge.modules.listInstalled() };
});
ipcMain.handle('modules:install-from-path', async (_e, filePath) => {
  if (!bridge) return { ok: false, error: 'not connected' };
  return bridge.modules.install(filePath);
});
ipcMain.handle('modules:uninstall', async (_e, name) => {
  if (!bridge) return { ok: false };
  return bridge.modules.uninstall(name);
});

// Skills tab
ipcMain.handle('skills:list', async () => bridge ? { entries: bridge.skills.listLocal() } : { entries: [] });
ipcMain.handle('skills:get', async (_e, id) => bridge ? bridge.skills.getLocal(id) : null);
ipcMain.handle('skills:add', async (_e, opts) => bridge ? bridge.skills.addLocal(Object.assign(opts, { deviceId: sm.getDeviceId() })) : null);
ipcMain.handle('skills:update', async (_e, opts) => bridge ? bridge.skills.updateLocal(opts.id, opts) : null);
ipcMain.handle('skills:delete', async (_e, id) => { if (bridge) bridge.skills.deleteLocal(id); return { ok: true }; });
ipcMain.handle('skills:search', async (_e, query) => bridge ? { entries: bridge.skills.searchLocal(query) } : { entries: [] });
ipcMain.handle('skills:sync', async () => { if (bridge) await bridge.skills.syncFromDb(); return { ok: true }; });

// Env vars
ipcMain.handle('env:list', async () => config.getEnvVars());
ipcMain.handle('env:set', async (_e, { key, value }) => { config.setEnvVar(key, value); return { ok: true }; });
ipcMain.handle('env:delete', async (_e, key) => { config.deleteEnvVar(key); return { ok: true }; });

// Terminal server
ipcMain.handle('terminal:start', async () => {
  try { return { ok: true, port: await startTerminalServer() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('terminal:stop', async () => { stopTerminalServer(); return { ok: true }; });
ipcMain.handle('terminal:status', async () => ({
  running: !!(terminalServer && terminalServer.isRunning()),
  port: terminalServer ? terminalServer.getPort() : -1,
}));

ipcMain.handle('shell:openExternal', async (_e, url) => { await shell.openExternal(url); return { ok: true }; });

// ============================ Credential tests ============================
// Each returns { valid: bool, detail: string }.
// Used by the Configure tab's per-input validity flags + "Test all" button.

const { fetch: httpFetch } = require('./supabase-client');

async function testProjectUrl(url) {
  if (!url || !/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url.trim())) {
    return { valid: false, detail: 'not a valid Supabase URL (expected https://<ref>.supabase.co)' };
  }
  try {
    const r = await httpFetch(url.replace(/\/+$/, '') + '/functions/v1/agent-prompt', { method: 'GET', timeoutMs: 10000 });
    if (r.status === 200) return { valid: true, detail: 'agent-prompt endpoint OK (200)' };
    return { valid: false, detail: 'HTTP ' + r.status };
  } catch (e) { return { valid: false, detail: e.message }; }
}

async function testPublishableKey(url, key) {
  if (!url || !key) return { valid: false, detail: 'URL + key required' };
  try {
    const r = await httpFetch(url.replace(/\/+$/, '') + '/functions/v1/list-devices', {
      method: 'GET', timeoutMs: 10000,
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
    });
    if (r.status === 200) return { valid: true, detail: 'list-devices OK (200)' };
    return { valid: false, detail: 'HTTP ' + r.status };
  } catch (e) { return { valid: false, detail: e.message }; }
}

async function testSecretKey(url, key) {
  if (!key) return { valid: false, detail: 'key required' };
  // Secret key is a JWT with role=service_role. We can verify the role
  // by decoding the payload (no signature verification — just structure check).
  try {
    const parts = key.split('.');
    if (parts.length !== 3) return { valid: false, detail: 'not a JWT (expected 3 dot-separated parts)' };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (payload.role !== 'service_role') {
      return { valid: false, detail: `JWT role is "${payload.role}" (expected "service_role")` };
    }
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return { valid: false, detail: 'JWT expired' };
    }
    return { valid: true, detail: `JWT valid (role=service_role, ref=${payload.ref || '?'})` };
  } catch (e) { return { valid: false, detail: 'not a valid JWT: ' + e.message }; }
}

async function testPAT(pat) {
  if (!pat || !pat.startsWith('sbp_')) return { valid: false, detail: 'must start with sbp_' };
  try {
    const r = await httpFetch('https://api.supabase.com/v1/projects', {
      method: 'GET', timeoutMs: 10000,
      headers: { 'Authorization': 'Bearer ' + pat },
    });
    if (r.status === 200) {
      const projects = JSON.parse(r.body);
      const n = Array.isArray(projects) ? projects.length : 0;
      return { valid: true, detail: `authenticated — ${n} project(s) visible` };
    }
    return { valid: false, detail: 'HTTP ' + r.status };
  } catch (e) { return { valid: false, detail: e.message }; }
}

ipcMain.handle('test:url', async (_e, url) => testProjectUrl(url));
ipcMain.handle('test:publishable', async (_e, { url, key }) => testPublishableKey(url, key));
ipcMain.handle('test:secret', async (_e, key) => testSecretKey(null, key));
ipcMain.handle('test:pat', async (_e, pat) => testPAT(pat));

ipcMain.handle('test:all', async (_e, { url, publishable, secret, pat }) => {
  const results = await Promise.all([
    testProjectUrl(url),
    testPublishableKey(url, publishable),
    testSecretKey(null, secret),
    testPAT(pat),
  ]);
  const validCount = results.filter((r) => r.valid).length;
  let overall;
  if (validCount === 4) overall = 'all-valid';
  else if (validCount === 0) overall = 'none-valid';
  else overall = 'some-valid';
  return {
    url:        results[0],
    publishable: results[1],
    secret:     results[2],
    pat:        results[3],
    validCount,
    overall,
  };
});
