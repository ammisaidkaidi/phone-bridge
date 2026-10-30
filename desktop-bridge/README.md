# Phone Bridge Desktop — Windows port of PortScanner (v2)

A Windows desktop port of the **PortScanner** Android app, built with
**Electron + Node.js**. This is the full Supabase bridge — listens for
commands via real-time WebSocket, executes them on Windows, hosts a
local Terminal HTTP API, keeps a heartbeat, manages permissions, env
vars, modules, knowledge, skills — all from a single 7-tab UI.

Compared to v1, this rewrite is a faithful port of the latest Android
app: every feature included, except the launcher apps grid + photo
theme + floating eye overlay (Android-only).

## Hardcoded defaults

The Supabase project URL + publishable + secret + PAT are baked into
`src/config-store.js` as `DEFAULTS`. The app works out-of-the-box —
just tap **🔗 Connect** on the Bridge tab.

- Project URL: `https://uskxgsncdqwznlikptmt.supabase.co`
- Publishable key: `eyJhbGciOi...anon` (JWT, public)
- Secret key: `eyJhbGciOi...service_role` (JWT, kept in config-store.js)
- PAT: stored base64-encoded in `src/config-store.js` (decoded at runtime)

## Quick start

```bash
cd desktop-bridge
npm install
npm start              # dev mode
npm run dist           # NSIS installer + portable .exe in dist/
```

## 7 tabs

1. **🔗 Bridge** — Connect/Disconnect/Test ping/Get AI Prompt/Refresh/
   Clear/Devices/Functions. Commands list with right-click context menu
   (Delete if finalized, else Mark as Success/Fail).
2. **💻 Terminal** — Local HTTP server on 127.0.0.1:8080. Run cmd.exe
   commands, send stdin (delivered/consumed modes), kill, refresh.
3. **⚙ Configure** — Supabase connection form + auto-provisioning (Run
   Setup / Redeploy functions / Copy SQL) + device identity + env vars
   editor.
4. **🔒 Perms** — Per-command DENY/ASK/ALLOW gate.
5. **📦 Modules** — .mdl module catalog (install/uninstall; metadata
   only on Windows — Dalvik bytecode can't run).
6. **🧠 Knowledge** — Local file cache of knowledge entries + DB sync.
7. **⚡ Skills** — Same as Knowledge but for skills.

## Windows command mapping

| Android | Windows |
|---------|---------|
| `shell` (sh -c) | `cmd.exe /c` |
| `shell_ps` (new) | `powershell.exe -NoProfile -Command` |
| `list_apps` (PackageManager) | scan Start Menu *.lnk |
| `list_processes` (ps -A) | `tasklist /FO CSV` |
| `kill_process` (force-stop) | `taskkill /F /PID/T` |
| `open_url` | `electron.shell.openExternal` |
| `notify` | Electron Notification API |
| `download_file` | Node https.get + fs.createWriteStream |
| `upload_file` | multipart POST to Supabase Storage |
| `whoami` | returns device_id/hostname/platform/arch/username/... |
| `privilege` | returns `app` (no Shizuku on Windows) |
| `env_list/get/set/delete` | stored in bridge-config.json |
| `knowledge_*` / `skills_*` | local .md files + DB sync |
| `module_list/install/uninstall` | catalog only |
| `vibrate` | system beep |
| `flash_*` / `wifi_*` / `hotspot_*` / `call_*` / `send_sms` / `broadcast` | no-op or "not supported" |

## Architecture

Renderer → preload (contextBridge) → main (IPC) → realtime-service →
command-executor → supabase-client → HTTPS/WSS → Supabase edge functions.
Tray icon (green/amber/red dot) replaces Android's FloatingEyeService.
Hide-to-tray on close. Auto-reconnect on launch.

No runtime npm deps — only `electron` + `electron-builder` as devDeps.
HTTP uses Node's built-in `https`; WebSocket uses Node 21+'s built-in
`WebSocket`.

## Files (53 total)

- `package.json` + `README.md` + `.gitignore`
- `scripts/extract_schema.py` — extracts SCHEMA_SQL from Android source
- `src/schema.sql` — 306 lines, 8 tables + RLS + indexes
- `src/edge-functions/*.ts` — 34 .ts sources (1:1 from Android res/raw)
- `src/config-store.js` — JSON persistence + hardcoded defaults
- `src/supabase-client.js` — HTTP + WebSocket for all 34 edge functions
- `src/supabase-manager.js` — auto-provisioning (PAT → schema + deploy)
- `src/command-executor.js` — per-device serial queue + all Windows commands
- `src/heartbeat-manager.js` — 10s heartbeat
- `src/realtime-service.js` — WebSocket listener + watchdog + backlog
- `src/terminal-server.js` — local HTTP API on 127.0.0.1:8080
- `src/permission-manager.js` — DENY/ASK/ALLOW gate
- `src/knowledge-manager.js` — local file cache + DB sync
- `src/module-manager.js` — .mdl catalog
- `src/main.js` — Electron main + tray + IPC
- `src/preload.js` — contextBridge
- `src/renderer/index.html` — 7-tab UI + activity log
- `src/renderer/styles.css` — dark theme
- `src/renderer/renderer.js` — wires every button
