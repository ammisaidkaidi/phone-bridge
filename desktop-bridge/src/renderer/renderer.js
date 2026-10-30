// src/renderer/renderer.js
// UI logic for all 7 tabs: Bridge + Terminal + Configure + Permissions +
// Modules + Knowledge + Skills.

'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  cmds: [], currentTermId: null,
};

// ---- Copy-to-clipboard helper ----
async function copyToClipboard(text, btnEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
  if (btnEl) {
    const orig = btnEl.textContent;
    btnEl.textContent = '✓';
    btnEl.classList.add('copied');
    setTimeout(() => { btnEl.textContent = orig; btnEl.classList.remove('copied'); }, 1200);
  }
}

// ---- Logging — each entry is a .log-line div with a hover copy button ----
// CAP at 500 lines to prevent unbounded DOM growth (each line creates
// 3 elements + 1 closure → thousands of lines = hundreds of MB of
// retained DOM + closures that V8 can't GC fast enough).
const MAX_LOG_LINES = 500;
function log(msg, level = 'info') {
  const logList = $('log');
  if (!logList) return;
  const ts = new Date().toISOString().slice(11, 19);
  const text = `[${ts}] ${msg}`;
  const line = document.createElement('div');
  line.className = 'log-line';
  const content = document.createElement('span');
  content.className = level;
  content.textContent = text;
  line.appendChild(content);
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '⧉';
  copyBtn.title = 'copy this line';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(text, copyBtn);
  });
  line.appendChild(copyBtn);
  logList.appendChild(line);
  // Trim oldest entries if over the cap.
  while (logList.childNodes.length > MAX_LOG_LINES) {
    logList.removeChild(logList.firstChild);
  }
  logList.scrollTop = logList.scrollHeight;
}
function setStatus(level, text) { $('status-dot').className = 'dot ' + level; $('status-text').textContent = text; }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'config') refreshConfigForm();
  if (name === 'perms') refreshPerms();
  if (name === 'modules') refreshModules();
  if (name === 'skills') refreshSkills();
}

// ============================ Config ============================
async function refreshConfigForm() {
  const cfg = await window.bridge.configGet();
  $('cfg-url').value = cfg.projectUrl || '';
  $('cfg-key').value = cfg.publishableKey || '';
  $('cfg-secret').value = cfg.secretKey || '';
  $('cfg-ref').value = cfg.projectRef || '';
  $('cfg-pat').value = cfg.personalAccessToken || '';
  $('device-info').textContent = `device_id: ${cfg.deviceId}\nname: ${cfg.deviceName}\nterminal_port: ${cfg.terminalPort || 8080}`;
  refreshEnvVars();
}
async function saveConfig() {
  await window.bridge.configSet({
    projectUrl: $('cfg-url').value.trim(),
    publishableKey: $('cfg-key').value.trim(),
    secretKey: $('cfg-secret').value.trim(),
    projectRef: $('cfg-ref').value.trim(),
    personalAccessToken: $('cfg-pat').value.trim(),
  });
  log('Config saved', 'ok'); updateBridgeStatus();
}
async function runSetup() {
  const pat = $('cfg-pat').value.trim();
  if (!pat) { log('PAT is empty', 'err'); return; }
  $('btn-run-setup').disabled = true;
  $('setup-result').textContent = 'Running setup… (this takes ~30-60s to deploy 34 edge functions)';
  $('setup-result').classList.remove('hidden');
  log('Running setup…', 'info');
  const result = await window.bridge.setupRun(pat);
  $('btn-run-setup').disabled = false;
  if (result.ok) {
    $('setup-result').textContent = `✓ Setup complete\n  project_ref: ${result.result.projectRef}\n  url: ${result.result.projectUrl}\n  publishable: …${result.result.publishableKey.slice(-12)}\n  secret: …${result.result.secretKey.slice(-8)}`;
    log('Setup complete', 'ok'); await refreshConfigForm(); updateBridgeStatus();
  } else {
    $('setup-result').textContent = '✗ Setup failed: ' + result.error;
    log('Setup failed: ' + result.error, 'err');
  }
}
async function redeployFns() {
  $('btn-redeploy-fns').disabled = true; log('Redeploying all 34 edge functions…', 'info');
  const r = await window.bridge.setupRedeployFns();
  $('btn-redeploy-fns').disabled = false;
  if (r.ok) log('All edge functions redeployed', 'ok'); else log('Redeploy failed: ' + r.error, 'err');
}
async function copySql() {
  const sql = await window.bridge.setupCopySql();
  await navigator.clipboard.writeText(sql);
  log(`Schema SQL copied (${sql.length} chars)`, 'ok');
  alert('Schema SQL copied to clipboard ✓\n\nPaste into Supabase SQL Editor at:\nhttps://supabase.com/dashboard/sql/new');
}

// ============================ Credential tests ============================
function setFlag(id, state, detail) {
  const el = $(id);
  if (!el) return;
  el.className = 'vi-flag ' + state;
  el.textContent = state === 'valid' ? '✓' : state === 'invalid' ? '✗' : state === 'testing' ? '…' : '?';
  if (detail) el.title = detail;
}

async function testOne(kind) {
  const url = $('cfg-url').value.trim();
  const publishable = $('cfg-key').value.trim();
  const secret = $('cfg-secret').value.trim();
  const pat = $('cfg-pat').value.trim();
  if (kind === 'url') {
    setFlag('flag-url', 'testing');
    const r = await window.bridge.testUrl(url);
    setFlag('flag-url', r.valid ? 'valid' : 'invalid', r.detail);
    return r.valid;
  }
  if (kind === 'publishable') {
    setFlag('flag-publishable', 'testing');
    const r = await window.bridge.testPublishable({ url, key: publishable });
    setFlag('flag-publishable', r.valid ? 'valid' : 'invalid', r.detail);
    return r.valid;
  }
  if (kind === 'secret') {
    setFlag('flag-secret', 'testing');
    const r = await window.bridge.testSecret(secret);
    setFlag('flag-secret', r.valid ? 'valid' : 'invalid', r.detail);
    return r.valid;
  }
  if (kind === 'pat') {
    setFlag('flag-pat', 'testing');
    const r = await window.bridge.testPAT(pat);
    setFlag('flag-pat', r.valid ? 'valid' : 'invalid', r.detail);
    return r.valid;
  }
  return false;
}

async function testAll() {
  const url = $('cfg-url').value.trim();
  const publishable = $('cfg-key').value.trim();
  const secret = $('cfg-secret').value.trim();
  const pat = $('cfg-pat').value.trim();
  // Set all to testing
  setFlag('flag-url', 'testing');
  setFlag('flag-publishable', 'testing');
  setFlag('flag-secret', 'testing');
  setFlag('flag-pat', 'testing');
  $('btn-test-all').className = 'test-btn testing';
  $('btn-test-all').textContent = '🧪 Testing…';
  log('Testing all credentials…', 'info');
  try {
    const r = await window.bridge.testAll({ url, publishable, secret, pat });
    setFlag('flag-url', r.url.valid ? 'valid' : 'invalid', r.url.detail);
    setFlag('flag-publishable', r.publishable.valid ? 'valid' : 'invalid', r.publishable.detail);
    setFlag('flag-secret', r.secret.valid ? 'valid' : 'invalid', r.secret.detail);
    setFlag('flag-pat', r.pat.valid ? 'valid' : 'invalid', r.pat.detail);
    $('btn-test-all').className = 'test-btn ' + r.overall;
    const label = r.overall === 'all-valid' ? '✓ All valid'
                : r.overall === 'none-valid' ? '✗ None valid'
                : `⚠ ${r.validCount}/4 valid`;
    $('btn-test-all').textContent = '🧪 ' + label;
    log(`Test all: ${r.validCount}/4 valid (${r.overall})`, r.overall === 'all-valid' ? 'ok' : r.overall === 'none-valid' ? 'err' : 'warn');
    for (const [k, v] of [['URL', r.url], ['Publishable', r.publishable], ['Secret', r.secret], ['PAT', r.pat]]) {
      log(`  ${k}: ${v.valid ? '✓' : '✗'} ${v.detail}`, v.valid ? 'ok' : 'err');
    }
  } catch (e) {
    log('Test all failed: ' + e.message, 'err');
    $('btn-test-all').className = 'test-btn none-valid';
    $('btn-test-all').textContent = '🧪 Test all';
  }
}

// Per-input test on blur (debounced)
function wireInputTest(inputId, flagId, kind) {
  const input = $(inputId);
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    setFlag(flagId, 'unknown', 'value changed — not tested yet');
    // Reset the test-all button color since state changed.
    $('btn-test-all').className = 'test-btn';
    $('btn-test-all').textContent = '🧪 Test all';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => testOne(kind), 800);
  });
}

// Log collapse toggle
// ---- Bridge tab: resizable divider between Activity Log + Recent Commands ----
function initBridgeResizer() {
  const resizer = $('bridge-resizer');
  const logPanel = $('bridge-log-panel');
  const split = $('bridge-split');
  if (!resizer || !logPanel || !split) return;
  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = split.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let percent = (x / rect.width) * 100;
    // Clamp between 15% and 85% so neither panel can collapse to zero.
    percent = Math.max(15, Math.min(85, percent));
    logPanel.style.flex = `0 0 ${percent}%`;
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Double-click the resizer → reset to default 40/60 split.
  resizer.addEventListener('dblclick', () => {
    logPanel.style.flex = '0 0 40%';
  });
}

// ============================ Env vars ============================
async function refreshEnvVars() {
  const env = await window.bridge.envList();
  $('env-list').textContent = Object.keys(env).length === 0 ? '(no env vars set)' : JSON.stringify(env, null, 2);
}
async function envSet() {
  const k = $('env-key').value.trim(); const v = $('env-value').value;
  if (!k) { log('Key required', 'err'); return; }
  await window.bridge.envSet(k, v);
  log(`Set ${k}=${v}`, 'ok'); refreshEnvVars();
}

// ============================ Bridge connect/disconnect ============================
async function doConnect() {
  const cfg = await window.bridge.configGet();
  if (!cfg.projectUrl || !cfg.publishableKey) { log('Not configured', 'err'); switchTab('config'); return; }
  log('Connecting…', 'info'); setStatus('warn', 'connecting…');
  await window.bridge.bridgeConnect();
  $('btn-connect').disabled = true; $('btn-disconnect').disabled = false;
}
async function doDisconnect() {
  await window.bridge.bridgeDisconnect();
  $('btn-connect').disabled = false; $('btn-disconnect').disabled = true;
  setStatus('off', 'disconnected'); log('Disconnected', 'warn');
}
async function updateBridgeStatus() {
  const s = await window.bridge.bridgeStatus();
  if (s.connected) { setStatus('on', 'connected'); $('btn-connect').disabled = true; $('btn-disconnect').disabled = false; }
  else if (s.configured) { setStatus('off', 'disconnected'); $('btn-connect').disabled = false; $('btn-disconnect').disabled = true; }
  else { setStatus('off', 'not configured'); }
}
window.bridge.onStatus((s) => {
  if (s === 'connected') { setStatus('on', 'connected'); log('Realtime connected', 'ok'); refreshCommands(); }
  else if (s === 'connecting') setStatus('warn', 'connecting…');
  else setStatus('off', 'disconnected');
});
window.bridge.onLog((p) => log(p.msg, p.level));

// ============================ Test ping + AI prompt ============================
async function sendTestPing() {
  log('Sending test ping…', 'info');
  const r = await window.bridge.testPing();
  log('Test ping: ' + JSON.stringify(r), r.ok === false ? 'err' : 'ok');
  refreshCommands();
}
async function getAiPrompt() {
  const prompt = await window.bridge.aiPromptGet();
  if (!prompt) { log('Not configured — fill in URL + key in Configure tab', 'err'); return; }
  await navigator.clipboard.writeText(prompt);
  log(`AI Prompt copied (${prompt.length} chars)`, 'ok');
  alert('AI Prompt copied to clipboard ✓\n\nPaste into your AI agent.\nThe agent will fetch the full system prompt from the URL at startup.');
}

// ============================ Commands list ============================
async function refreshCommands() {
  const r = await window.bridge.commandsList({ limit: 30 });
  state.cmds = (r && r.body && r.body.commands) || [];
  renderCommands();
  const cfg = await window.bridge.configGet();
  const status = await window.bridge.bridgeStatus();
  if (status.configured) {
    $('bridge-status').textContent =
      `Bridge: configured\nProject: ${cfg.projectRef}\nConnection: ${status.connected ? '🟢 connected' : '🔴 disconnected'}\nDevice: ${cfg.deviceName} (${cfg.deviceId})`;
  }
}
function renderCommands() {
  const list = $('commands-list');
  list.innerHTML = '';
  if (state.cmds.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);justify-content:center;padding:16px">No commands yet — tap "Test ping" to send one.</div>';
    return;
  }
  for (const c of state.cmds) {
    const row = document.createElement('div');
    row.className = 'cmd-row'; row.dataset.id = c.id;
    const status = String(c.status || '').toLowerCase();
    const dotClass = ['pending', 'processing', 'completed', 'failed'].includes(status) ? status : 'idle';
    const truncatedResult = (c.result || c.error || '').slice(0, 200);
    row.innerHTML = `
      <div class="cmd-dot ${dotClass}"></div>
      <div class="cmd-body">
        <div class="cmd-meta">
          <span class="id">#${c.id}</span>
          <span class="state ${status}">${status.toUpperCase()}</span>
          <span>${escapeHtml(c.command || '?')}</span>
          <span class="ts">${escapeHtml(c.created_at || '')}</span>
        </div>
        <div class="cmd-text">$ ${escapeHtml(c.command || '?')} ${escapeHtml(JSON.stringify(c.args || {}))}</div>
        ${truncatedResult ? `<div class="cmd-result">${escapeHtml(truncatedResult)}</div>` : ''}
      </div>
      <button class="copy-btn" title="copy command line">⧉</button>`;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showCommandContextMenu(e, c); });
    // Click the copy button → copy the full command line to clipboard.
    const copyBtn = row.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fullText = `#${c.id} [${status.toUpperCase()}] ${c.command} ${JSON.stringify(c.args || {})}\n` +
          (c.result ? `result: ${c.result}` : c.error ? `error: ${c.error}` : '');
        copyToClipboard(fullText, copyBtn);
      });
    }
    list.appendChild(row);
  }
}
function showCommandContextMenu(e, cmd) {
  const status = String(cmd.status || '').toLowerCase();
  const finalized = (status === 'completed' || status === 'failed');
  const items = finalized
    ? [{ label: '🗑 Delete', action: () => deleteCommand(cmd.id) }]
    : [
        { label: '✓ Mark as Success', action: () => markCommand(cmd.id, 'completed', '[manual override]') },
        { label: '✗ Mark as Fail',    action: () => markCommand(cmd.id, 'failed', null, '[manual override]') },
      ];
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px';
  for (const item of items) {
    const div = document.createElement('div');
    div.textContent = item.label;
    div.onclick = async () => { menu.remove(); await item.action(); };
    menu.appendChild(div);
  }
  document.body.appendChild(menu);
  const closer = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closer); } };
  setTimeout(() => document.addEventListener('mousedown', closer), 0);
}
async function deleteCommand(id) { await window.bridge.commandsDelete(id); log(`Deleted #${id}`, 'ok'); refreshCommands(); }
async function markCommand(id, status, result, error) {
  await window.bridge.commandsMark({ id, status, result, error });
  log(`Marked #${id} as ${status}`, 'ok'); refreshCommands();
}
async function clearCommands() {
  // Only delete completed + failed commands — leave pending/processing ones.
  const toDelete = state.cmds.filter((c) => {
    const s = String(c.status || '').toLowerCase();
    return s === 'completed' || s === 'failed';
  });
  if (toDelete.length === 0) {
    log('No completed/failed commands to clear', 'warn');
    return;
  }
  if (!confirm(`Delete ${toDelete.length} completed/failed command(s)?\n(pending + processing commands will be kept)`)) return;
  let ok = 0, fail = 0;
  for (const c of toDelete) {
    const r = await window.bridge.commandsDelete(c.id);
    if (r && r.body && r.body.ok) ok++; else fail++;
  }
  log(`Cleared ${ok} command(s)${fail > 0 ? `, ${fail} failed` : ''}`, ok > 0 ? 'ok' : 'err');
  refreshCommands();
}
async function listDevices() {
  const r = await window.bridge.devicesList();
  const devices = (r && r.body && r.body.devices) || [];
  log(`Devices online: ${devices.length}`, 'ok');
  for (const d of devices) log(`  • ${d.name} [${d.alive ? 'alive' : 'stale'}] device_id=${d.device_id.slice(0, 12)}… privilege=${d.privilege_level}`, 'info');
}
async function listFunctions() {
  const r = await window.bridge.functionsList();
  const fns = (r && r.body && r.body.functions) || [];
  log(`Functions supported: ${fns.length}`, 'ok');
  for (const f of fns.slice(0, 20)) log(`  • ${f.name}`, 'info');
}

// ============================ Terminal ============================
async function termStart() {
  const r = await window.bridge.terminalStart();
  if (r.ok) { log(`Terminal server started on port ${r.port}`, 'ok'); termRefreshStatus(); }
  else log('Terminal server failed: ' + r.error, 'err');
}
async function termStop() { await window.bridge.terminalStop(); log('Terminal server stopped', 'warn'); termRefreshStatus(); }
async function termRefreshStatus() {
  const s = await window.bridge.terminalStatus();
  $('btn-term-start').disabled = s.running;
  $('btn-term-stop').disabled = !s.running;
  $('term-status').textContent = s.running ? `server: running on port ${s.port}` : 'server: stopped';
}
async function termExec() {
  const s = await window.bridge.terminalStatus();
  if (!s.running) { log('Start the terminal server first', 'err'); return; }
  const cmd = $('term-cmd').value.trim();
  if (!cmd) { log('Type a command first', 'err'); return; }
  appendTermOutput(`$ ${cmd}\n`);
  $('term-cmd-id').textContent = 'id: submitting…';
  try {
    const resp = await fetch(`http://127.0.0.1:${s.port}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    const body = await resp.json();
    if (resp.status === 202) {
      state.currentTermId = body.id;
      $('term-cmd-id').textContent = 'id: ' + body.id;
      termRefresh();
    } else { $('term-cmd-id').textContent = 'id: error'; appendTermOutput(`Exec failed: ${JSON.stringify(body)}\n`); }
  } catch (e) { appendTermOutput(`Exec error: ${e.message}\n`); }
}
async function termRefresh() {
  const s = await window.bridge.terminalStatus();
  if (!s.running || !state.currentTermId) return;
  try {
    const resp = await fetch(`http://127.0.0.1:${s.port}/result?id=${state.currentTermId}`);
    if (!resp.ok) return;
    const o = await resp.json();
    const banner = `── status=${o.status}${o.exitCode != null ? ' exit=' + o.exitCode : ''}${o.error ? ' error=' + o.error : ''} ──\n`;
    const cur = $('term-output').textContent;
    const lastPrompt = cur.lastIndexOf('\n$ ');
    const head = lastPrompt >= 0 ? cur.slice(0, lastPrompt + 1) : '';
    $('term-output').textContent = head + `$ ${o.req}\n${o.resp || ''}${(o.resp && !o.resp.endsWith('\n')) ? '\n' : ''}${banner}`;
    $('term-cmd-id').textContent = `id: ${state.currentTermId}  [${o.status}]`;
    $('btn-term-kill').disabled = (o.status !== 'running');
    document.querySelector('.term-output-wrapper').scrollTop = 99999;
  } catch (_) {}
}
async function termKill() {
  const s = await window.bridge.terminalStatus();
  if (!s.running || !state.currentTermId) return;
  await fetch(`http://127.0.0.1:${s.port}/kill?id=${state.currentTermId}`, { method: 'POST' });
  log('Kill signal sent', 'warn'); termRefresh();
}
async function termSendStdin() {
  const s = await window.bridge.terminalStatus();
  if (!s.running || !state.currentTermId) { log('Run a command first', 'err'); return; }
  const data = $('term-stdin').value; const mode = $('term-mode').value;
  appendTermOutput(`stdin [${mode}]: ${data.replace(/\n/g, '\\n')}\n`);
  const resp = await fetch(`http://127.0.0.1:${s.port}/input?id=${state.currentTermId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, mode }),
  });
  const ack = await resp.json();
  appendTermOutput(`  ack: ${JSON.stringify(ack)}\n`);
}
function appendTermOutput(text) {
  $('term-output').textContent += text;
  document.querySelector('.term-output-wrapper').scrollTop = 99999;
}
function termClear() { $('term-output').textContent = ''; }

// ============================ Permissions ============================
async function refreshPerms() {
  const all = await window.bridge.permsGetAll();
  $('perm-list').textContent = Object.keys(all).length === 0 ? '(no overrides — all ALLOW)' : JSON.stringify(all, null, 2);
}
async function permSet() {
  const cmd = $('perm-cmd').value.trim();
  const decision = $('perm-decision').value;
  if (!cmd) { log('Command name required', 'err'); return; }
  await window.bridge.permsSet(cmd, decision);
  log(`Set ${cmd} → ${decision}`, 'ok'); refreshPerms();
}

// ============================ Modules ============================
async function refreshModules() {
  const r = await window.bridge.modulesList();
  const mods = (r && r.modules) || [];
  $('mod-list').textContent = mods.length === 0 ? '(no modules installed)' : JSON.stringify(mods, null, 2);
}
async function modInstall() {
  const p = $('mod-path').value.trim();
  if (!p) { log('Path required', 'err'); return; }
  const r = await window.bridge.modulesInstallFromPath(p);
  if (r.ok) log(`Installed ${r.name} v${r.version} (${r.commands.length} commands)`, 'ok');
  else log('Install failed: ' + r.error, 'err');
  refreshModules();
}

// ============================ Skills ============================
async function refreshSkills() {
  const r = await window.bridge.skillsList();
  const entries = (r && r.entries) || [];
  $('sk-list').textContent = entries.length === 0 ? '(no entries)' : JSON.stringify(entries, null, 2);
}
async function skAdd() {
  const title = $('sk-title').value.trim();
  const content = $('sk-content').value;
  if (!title || !content) { log('Title + content required', 'err'); return; }
  const tags = $('sk-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  const summary = $('sk-summary').value;
  const e = await window.bridge.skillsAdd({ title, summary, content, tags });
  log(`Added skill "${e.title}" (id=${e.id})`, 'ok');
  $('sk-title').value = ''; $('sk-tags').value = ''; $('sk-summary').value = ''; $('sk-content').value = '';
  refreshSkills();
}
async function skSync() { await window.bridge.skillsSync(); log('Skills sync complete', 'ok'); refreshSkills(); }
async function skSearch() {
  const q = $('sk-search').value.trim();
  if (!q) { refreshSkills(); return; }
  const r = await window.bridge.skillsSearch(q);
  $('sk-list').textContent = JSON.stringify(r.entries || [], null, 2);
}

// ============================ Wire up ============================
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  // Bridge
  $('btn-connect').addEventListener('click', doConnect);
  $('btn-disconnect').addEventListener('click', doDisconnect);
  $('btn-test-ping').addEventListener('click', sendTestPing);
  $('btn-get-prompt').addEventListener('click', getAiPrompt);
  $('btn-refresh-cmds').addEventListener('click', refreshCommands);
  $('btn-clear-cmds').addEventListener('click', clearCommands);
  $('btn-list-devices').addEventListener('click', listDevices);
  $('btn-list-functions').addEventListener('click', listFunctions);
  // Terminal
  $('btn-term-start').addEventListener('click', termStart);
  $('btn-term-stop').addEventListener('click', termStop);
  $('btn-term-exec').addEventListener('click', termExec);
  $('btn-term-kill').addEventListener('click', termKill);
  $('btn-term-send').addEventListener('click', termSendStdin);
  $('btn-term-refresh').addEventListener('click', termRefresh);
  $('btn-term-clear').addEventListener('click', termClear);
  // Configure
  $('btn-save-config').addEventListener('click', saveConfig);
  $('btn-load-config').addEventListener('click', refreshConfigForm);
  $('btn-run-setup').addEventListener('click', runSetup);
  $('btn-redeploy-fns').addEventListener('click', redeployFns);
  $('btn-copy-sql').addEventListener('click', copySql);
  $('btn-env-set').addEventListener('click', envSet);
  $('btn-env-refresh').addEventListener('click', refreshEnvVars);
  // Credential tests
  $('btn-test-all').addEventListener('click', testAll);
  wireInputTest('cfg-url', 'flag-url', 'url');
  wireInputTest('cfg-key', 'flag-publishable', 'publishable');
  wireInputTest('cfg-secret', 'flag-secret', 'secret');
  wireInputTest('cfg-pat', 'flag-pat', 'pat');
  // Log clear (button now lives inside the bridge-log-panel header)
  $('btn-clear-log').addEventListener('click', () => { $('log').textContent = ''; $('log').innerHTML = ''; });
  // Bridge tab resizable divider
  initBridgeResizer();
  // Perms
  $('btn-perm-set').addEventListener('click', permSet);
  $('btn-perm-refresh').addEventListener('click', refreshPerms);
  // Modules
  $('btn-mod-install').addEventListener('click', modInstall);
  $('btn-mod-refresh').addEventListener('click', refreshModules);
  // Skills
  $('btn-sk-add').addEventListener('click', skAdd);
  $('btn-sk-sync').addEventListener('click', skSync);
  $('btn-sk-refresh').addEventListener('click', refreshSkills);
  $('btn-sk-search').addEventListener('click', skSearch);
  // Initial state
  refreshConfigForm(); updateBridgeStatus(); termRefreshStatus(); refreshCommands();
  // Auto-refresh commands every 5s while connected
  setInterval(() => { window.bridge.bridgeStatus().then((s) => { if (s.connected) refreshCommands(); }); }, 5000);
  // Auto-refresh terminal output every 2s
  setInterval(() => { if (state.currentTermId) termRefresh(); }, 2000);
  log('Phone Bridge Desktop ready', 'ok');
});
