// src/supabase-manager.js
//
// Auto-provisions the Supabase project using the embedded PAT. Mirror of
// Android SupabaseManager.java:
//   1. GET  /v1/projects           → list user's projects, pick first ACTIVE
//   2. POST /v1/projects/{ref}/database/query → run SCHEMA_SQL
//   3. GET  /v1/projects/{ref}/api-keys → fetch publishable + secret keys
//   4. deploy 34 edge functions via /v1/projects/{ref}/functions/deploy
//   5. persist to config-store
//
// SCHEMA_SQL is loaded at startup from src/schema.sql (extracted from
// Android SupabaseManager.java by scripts/extract_schema.py).
//
// The 34 edge functions are loaded at deploy time from
// src/edge-functions/<slug>.ts (copied 1:1 from Android res/raw/*.txt).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetch } = require('./supabase-client');
const config = require('./config-store');

const MANAGEMENT_API = 'https://api.supabase.com/v1';
const EDGE_FUNCTIONS_DIR = path.join(__dirname, 'edge-functions');

const EDGE_FUNCTIONS = [
  ['send-command',        'send_command.ts'],
  ['get-result',          'get_result.ts'],
  ['list-commands',       'list_commands.ts'],
  ['update-result',       'update_result.ts'],
  ['delete-command',      'delete_command.ts'],
  ['clear-commands',      'clear_commands.ts'],
  ['list-devices',        'list_devices.ts'],
  ['list-functions',      'list_functions.ts'],
  ['list-modules',        'list_modules.ts'],
  ['upload-module',       'upload_module.ts'],
  ['upload-file',         'upload_file.ts'],
  ['list-files',          'list_files.ts'],
  ['delete-file',         'delete_file.ts'],
  ['heartbeat',           'heartbeat.ts'],
  ['recover-stale',       'recover_stale.ts'],
  ['agent-prompt',        'agent_prompt.ts'],
  ['knowledge-sync',      'knowledge_sync.ts'],
  ['knowledge-pull',      'knowledge_pull.ts'],
  ['knowledge-delete',    'knowledge_delete.ts'],
  ['skills-sync',         'skills_sync.ts'],
  ['skills-pull',         'skills_pull.ts'],
  ['skills-delete',       'skills_delete.ts'],
  ['cleanup-old-files',   'cleanup_old_files.ts'],
  ['agent-register',      'agent_register.ts'],
  ['agent-heartbeat',     'agent_heartbeat.ts'],
  ['agent-list',          'agent_list.ts'],
  ['chat-create',         'chat_create.ts'],
  ['chat-list',           'chat_list.ts'],
  ['chat-send',           'chat_send.ts'],
  ['chat-get-all',        'chat_get_all.ts'],
  ['chat-wait-for-ask',   'chat_wait_for_ask.ts'],
  ['chat-wait-for-result','chat_wait_for_result.ts'],
  ['chat-ack',            'chat_ack.ts'],
  ['chat-ask',            'chat_ask.ts'],
  // Chat extras (unreaded / readed)
  ['chat-unreaded',       'chat_unreaded.ts'],
  ['chat-readed',         'chat_readed.ts'],
  // Rooms (multi-agent floor control — one speaker at a time)
  ['room-create',         'room_create.ts'],
  ['room-join',           'room_join.ts'],
  ['room-request-speaker','room_request_speaker.ts'],
  ['room-get-speaker',    'room_get_speaker.ts'],
  ['room-release-speaker','room_release_speaker.ts'],
  ['room-ask-next',       'room_ask_next.ts'],
  // TmpDB — agent scratchpad tables in the 'temporary' schema
  ['TmpDB-createTable',   'tmpdb_create_table.ts'],
  ['TmpDB-listTables',    'tmpdb_list_tables.ts'],
  ['TmpDB-dropTable',     'tmpdb_drop_table.ts'],
  ['TmpDB-insertRow',     'tmpdb_insert_row.ts'],
  ['TmpDB-getRows',       'tmpdb_get_rows.ts'],
  ['TmpDB-updateRow',     'tmpdb_update_row.ts'],
  ['TmpDB-deleteRow',     'tmpdb_delete_row.ts'],
  ['TmpDB-stream',        'tmpdb_stream.ts'],
];

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

class SetupResult {
  constructor() {
    this.projectRef = '';
    this.projectUrl = '';
    this.publishableKey = '';
    this.secretKey = '';
    this.message = '';
  }
}

async function setup(pat) {
  if (!pat || !pat.startsWith('sbp_')) {
    throw new Error('No valid PAT found. Get one at https://supabase.com/dashboard/account/tokens');
  }
  const r = new SetupResult();

  // 1. List projects
  const listResp = await fetch(MANAGEMENT_API + '/projects', {
    method: 'GET', headers: { Authorization: 'Bearer ' + pat },
  });
  if (listResp.status < 200 || listResp.status >= 300) {
    throw new Error('List projects failed: HTTP ' + listResp.status + '\n' + listResp.body);
  }
  const projects = JSON.parse(listResp.body);
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('No Supabase projects found. Create one at https://supabase.com/dashboard first.');
  }
  let picked = null;
  for (const p of projects) {
    if (String(p.status || '').toUpperCase().startsWith('ACTIVE')) { picked = p; break; }
  }
  if (!picked) {
    const names = projects.map((p) => `  - ${p.name} [${p.status}] ref=${p.id}`).join('\n');
    throw new Error('No ACTIVE projects. Found:\n' + names);
  }
  r.projectRef = picked.id;
  r.projectUrl = 'https://' + r.projectRef + '.supabase.co';

  // 2. Run SCHEMA_SQL
  const sqlResp = await fetch(MANAGEMENT_API + '/projects/' + r.projectRef + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SCHEMA_SQL }),
  });
  if (sqlResp.status < 200 || sqlResp.status >= 300) {
    throw new Error('Schema setup failed: HTTP ' + sqlResp.status + '\nSupabase says: ' + sqlResp.body
      + '\n\n→ Run the SQL manually in the SQL Editor at https://supabase.com/dashboard/project/'
      + r.projectRef + '/sql/new');
  }

  // 3. Fetch API keys
  const keysResp = await fetch(MANAGEMENT_API + '/projects/' + r.projectRef + '/api-keys', {
    method: 'GET', headers: { Authorization: 'Bearer ' + pat },
  });
  if (keysResp.status < 200 || keysResp.status >= 300) {
    throw new Error('Fetch API keys failed: HTTP ' + keysResp.status);
  }
  const keys = JSON.parse(keysResp.body);
  for (const k of keys) {
    const name = String(k.name || '').toLowerCase();
    const val = k.api_key;
    if (!val) continue;
    if (name === 'publishable') r.publishableKey = val;
    else if (name === 'secret') r.secretKey = val;
    else if (name === 'anon' && !r.publishableKey) r.publishableKey = val;
    else if (name === 'service_role' && !r.secretKey) r.secretKey = val;
  }
  if (!r.publishableKey) throw new Error('No publishable/anon key found in project.');

  // 4. Persist
  config.patch({
    projectRef: r.projectRef,
    projectUrl: r.projectUrl,
    publishableKey: r.publishableKey,
    secretKey: r.secretKey || '',
    personalAccessToken: pat,
  });

  // 5. Deploy edge functions (best-effort — failures collected, not thrown)
  await deployEdgeFunctions(pat, r.projectRef);

  r.message = 'Setup complete. Project: ' + r.projectRef;
  return r;
}

async function deployEdgeFunctions(pat, projectRef) {
  let ok = 0, failed = 0;
  const failures = [];
  for (const [slug, filename] of EDGE_FUNCTIONS) {
    const filepath = path.join(EDGE_FUNCTIONS_DIR, filename);
    let source;
    try { source = fs.readFileSync(filepath, 'utf8'); }
    catch (_) { failed++; failures.push(`${slug}: source file missing (${filename})`); continue; }
    try {
      await deployOne(pat, projectRef, slug, source);
      ok++;
    } catch (e) {
      failed++; failures.push(`${slug}: ${e.message}`);
    }
  }
  console.log(`Edge functions deployed: ${ok} ok, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`Deployed ${ok}/${EDGE_FUNCTIONS.length} edge functions. Failures:\n  `
      + failures.join('\n  '));
  }
}

async function deployOne(pat, projectRef, slug, source) {
  const metadata = JSON.stringify({ name: slug, entrypoint_path: 'index.ts', verify_jwt: false });
  const boundary = '----boundary' + Math.random().toString(16).slice(2);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: text/typescript\r\n\r\n${source}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = Buffer.from(parts.join(''), 'utf8');
  const url = MANAGEMENT_API + '/projects/' + projectRef + '/functions/deploy?slug=' + slug;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + pat,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
    },
    body,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error('HTTP ' + resp.status + ' — ' + resp.body.slice(0, 200));
  }
}

// ---- Accessors (with hardcoded defaults baked into config-store) ----
function isConfigured() {
  const c = config.all();
  return !!(c.projectUrl && c.publishableKey);
}
function getProjectUrl()    { return config.get('projectUrl'); }
function getProjectRef()    { return config.get('projectRef'); }
function getPublishableKey(){ return config.get('publishableKey'); }
function getSecretKey()     { return config.get('secretKey'); }
function getDeviceId()      { return config.get('deviceId'); }
function getDeviceName()    { return config.get('deviceName'); }

module.exports = {
  setup, deployEdgeFunctions, isConfigured,
  getProjectUrl, getProjectRef, getPublishableKey, getSecretKey,
  getDeviceId, getDeviceName, SCHEMA_SQL, EDGE_FUNCTIONS,
};
