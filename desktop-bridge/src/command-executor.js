// src/command-executor.js
//
// Executes commands received from the AI agent on this Windows machine.
// Per-device serial queue: same single-worker model as the Android app.
// Control commands bypass the queue.
//
// Supported commands on Windows:
//   ping, shell (cmd.exe), shell_ps (PowerShell), open_app, close_app,
//   list_apps, list_processes, kill_process, open_url, notify,
//   download_file, upload_file, execute_script, vibrate, flash_on/off,
//   broadcast, wifi_*, hotspot_*, call_number, send_sms (not supported),
//   command_stop/pause/resume/list_running/status,
//   whoami, privilege, env_list/get/set/delete,
//   knowledge_list/get/add/update/delete/search,
//   skills_list/get/add/update/delete/search,
//   module_list, module_install, module_uninstall, list_functions.

'use strict';

const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Notification } = require('electron');

const TAG = 'CommandExecutor';

class RunningCommand {
  constructor(id, command, args) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.startedAt = Date.now();
    this.process = null;
    this.paused = false;
    this.status = 'queued';
    this.future = null;
  }
}

class CommandExecutor {
  /**
   * @param {object} deps
   * @param {object} deps.client         SupabaseClient (for writeResult, uploadFile, etc.)
   * @param {object} deps.heartbeat      HeartbeatManager (for session id)
   * @param {object} deps.knowledge      KnowledgeManager (for knowledge/ skills)
   * @param {object} deps.skills         KnowledgeManager (kind='skills')
   * @param {object} deps.modules        ModuleManager
   * @param {function} deps.onLog        (msg, level) => void
   */
  constructor({ client, heartbeat, knowledge, skills, modules, onLog }) {
    this.client = client;
    this.heartbeat = heartbeat;
    this.knowledge = knowledge;
    this.skills = skills;
    this.modules = modules;
    this.onLog = onLog || ((m, l) => console.log(`[${l}] ${m}`));
    this._queue = [];
    this._running = false;
    this._current = null;
    this._runningMap = new Map();
    this._shuttingDown = false;
  }

  shutdown() {
    this._shuttingDown = true;
    for (const rc of this._runningMap.values()) {
      if (rc.process) { try { rc.process.kill('SIGTERM'); } catch (_) {} }
    }
    this._runningMap.clear();
    this._queue.length = 0;
  }

  getCurrentlyExecuting() {
    return this._current ? this._current.id : null;
  }

  async handle(record) {
    if (!record || record.id == null) return;
    const id = Number(record.id);
    const command = String(record.command || '').trim();
    const args = record.args || {};

    const sm = require('./supabase-manager');
    const targetDeviceId = record.device_id;
    const myDeviceId = sm.getDeviceId();
    if (targetDeviceId && targetDeviceId !== 'null' && targetDeviceId !== myDeviceId) {
      this.onLog(`Skipping cmd #${id} — targeted at device ${targetDeviceId} (not us: ${myDeviceId})`, 'info');
      return;
    }

    // Mark processing in DB.
    const sessionId = this.heartbeat ? this.heartbeat.getSessionId() : null;
    const pid = process.pid;
    try {
      await this.client.updateResult({
        id, status: 'processing',
        exec_session_id: sessionId, executor_pid: pid,
      });
    } catch (e) {
      this.onLog(`markProcessing failed for #${id}: ${e.message}`, 'warn');
    }

    // Permission gate (synchronous).
    const perms = require('./permission-manager');
    const decision = perms.getDecision(command);
    if (decision === perms.DECISION.DENY) {
      await this.client.updateResult({
        id, status: 'failed', error: 'permission_denied: user set DENY for ' + command,
      });
      this.onLog(`Cmd #${id} denied: ${command}`, 'warn');
      return;
    }
    // ASK on Windows is treated as ALLOW (the UI is always visible —
    // the user can switch to DENY in the Permissions tab to block).

    // Control commands bypass the queue.
    if (this._isControlCommand(command)) {
      try {
        const r = await this._dispatch(command, args, id);
        await this.client.updateResult({ id, status: r.status, result: r.result, error: r.error });
      } catch (e) {
        await this.client.updateResult({ id, status: 'failed', error: e.message });
      }
      return;
    }

    // Submit to queue.
    const rc = new RunningCommand(id, command, args);
    this._runningMap.set(id, rc);
    this._queue.push(rc);
    this._pumpQueue();
  }

  _isControlCommand(c) {
    return ['command_stop', 'command_pause', 'command_resume',
            'command_list_running', 'command_status'].includes(c);
  }

  _pumpQueue() {
    if (this._running || this._shuttingDown) return;
    const rc = this._queue.shift();
    if (!rc) return;
    this._running = true;
    this._current = rc;
    rc.status = 'running';
    (async () => {
      try {
        const r = await this._dispatch(rc.command, rc.args, rc.id);
        rc.status = r.status;
        await this.client.updateResult({
          id: rc.id, status: r.status, result: r.result, error: r.error,
        });
      } catch (e) {
        rc.status = 'failed';
        await this.client.updateResult({
          id: rc.id, status: 'failed', error: e.message,
        });
      } finally {
        this._running = false;
        this._current = null;
        this._runningMap.delete(rc.id);
        this._pumpQueue();
      }
    })();
  }

  async _dispatch(command, args, id) {
    args = args || {};
    switch (command) {
      case 'ping':
        return { status: 'completed', result: 'pong' };

      case 'shell':
        return this._doShell(args, { shell: 'cmd.exe', flag: '/c' });

      case 'shell_ps':
        return this._doShell(args, { shell: 'powershell.exe', flag: '-NoProfile -Command' });

      // ---- Windows system commands (new) ----
      case 'cmd': {
        // Open an interactive cmd.exe window (detached).
        try {
          const child = spawn('cmd.exe', [], { detached: true, stdio: 'ignore', cwd: args.cwd || undefined });
          child.unref();
          return { status: 'completed', result: `Opened cmd.exe (pid=${child.pid})` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'open_powershell': {
        try {
          const child = spawn('powershell.exe', ['-NoProfile'], { detached: true, stdio: 'ignore', cwd: args.cwd || undefined });
          child.unref();
          return { status: 'completed', result: `Opened powershell.exe (pid=${child.pid})` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'command_admin': {
        // Run a command as administrator via ShellExecute "runas" verb.
        // Uses PowerShell's Start-Process -Verb RunAs for UAC prompt.
        const cmd = String(args.cmd || '');
        if (!cmd) return { status: 'failed', error: 'args.cmd required' };
        return this._doShell(
          { cmd: `powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ${cmd.replace(/"/g, '\\"')}' -Verb RunAs -Wait"`, timeout_ms: Number(args.timeout_ms || 60000) },
          { shell: 'cmd.exe', flag: '/c' });
      }

      case 'open_process': {
        // Alias for open_app — start a process by exe path.
        const exePath = String(args.path || args.exe || args.package || '');
        if (!exePath) return { status: 'failed', error: 'args.path required' };
        try {
          const child = spawn(exePath, args.args || [], { detached: true, stdio: 'ignore', cwd: args.cwd || undefined });
          child.unref();
          return { status: 'completed', result: `Started: ${exePath} (pid=${child.pid})` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'logoff':
        return this._doShell({ cmd: 'shutdown /l', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'lock': {
        // Lock the workstation.
        return this._doShell({ cmd: 'rundll32.exe user32.dll,LockWorkStation', timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });
      }

      case 'shutdown': {
        const delay = Number(args.delay || 0);
        return this._doShell({ cmd: `shutdown /s /t ${delay}`, timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });
      }

      case 'restart': {
        const delay = Number(args.delay || 0);
        return this._doShell({ cmd: `shutdown /r /t ${delay}`, timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });
      }

      case 'abort_shutdown':
        return this._doShell({ cmd: 'shutdown /a', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'sleep':
        return this._doShell({ cmd: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0', timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });

      case 'hibernate':
        return this._doShell({ cmd: 'shutdown /h', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'open_explorer': {
        const dir = String(args.path || 'C:\\');
        return this._doShell({ cmd: `explorer "${dir}"`, timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });
      }

      case 'open_control_panel':
        return this._doShell({ cmd: 'control.exe', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'open_task_manager':
        return this._doShell({ cmd: 'taskmgr.exe', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'open_registry_editor':
        return this._doShell({ cmd: 'regedit.exe', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'open_settings':
        return this._doShell({ cmd: 'start ms-settings:', timeout_ms: 5000 }, { shell: 'cmd.exe', flag: '/c' });

      case 'empty_recycle_bin':
        return this._doShell({ cmd: 'rd /s /q %systemdrive%\\$Recycle.Bin', timeout_ms: 10000 },
                             { shell: 'cmd.exe', flag: '/c' });

      case 'set_volume': {
        // Set system volume (0-100). Uses PowerShell's audio API.
        const vol = Math.max(0, Math.min(100, Number(args.level || 0)));
        return this._doShell({
          cmd: `powershell -NoProfile -Command "$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]174); Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Audio{[DllImport(\\"user32.dll\\")]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m(IntPtr w,string l,uint f,out IntPtr r);}'"`,
          timeout_ms: 10000,
        }, { shell: 'cmd.exe', flag: '/c' });
      }

      case 'mute':
        return this._doShell({ cmd: 'powershell -NoProfile -Command "$o=New-Object -ComObject WScript.Shell; $o.SendKeys([char]173)"', timeout_ms: 5000 },
                             { shell: 'cmd.exe', flag: '/c' });

      case 'open_url': {
        const url = String(args.url || '');
        if (!url) return { status: 'failed', error: 'args.url required' };
        try {
          const { shell } = require('electron');
          await shell.openExternal(url);
          return { status: 'completed', result: `Opened URL: ${url}` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'open_app': {
        const exePath = String(args.package || args.exe || '');
        if (!exePath) return { status: 'failed', error: 'args.package (exe path) required' };
        try {
          const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
          child.unref();
          return { status: 'completed', result: `Started: ${exePath} (pid=${child.pid})` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'close_app': {
        const exe = String(args.package || args.exe || '');
        if (!exe) return { status: 'failed', error: 'args.package required' };
        return this._doShell(
          { cmd: `taskkill /F /IM "${path.basename(exe)}" /T`, timeout_ms: 5000 },
          { shell: 'cmd.exe', flag: '/c' });
      }

      case 'list_apps':
        return this._doListApps(args);

      case 'list_processes': {
        const filter = args.filter ? `| findstr /I "${args.filter}"` : '';
        return this._doShell({ cmd: `tasklist /FO CSV ${filter}`, timeout_ms: 8000 },
                             { shell: 'cmd.exe', flag: '/c' });
      }

      case 'kill_process': {
        if (args.pid) {
          return this._doShell({ cmd: `taskkill /F /PID ${Number(args.pid)} /T`, timeout_ms: 5000 },
                               { shell: 'cmd.exe', flag: '/c' });
        } else if (args.package) {
          return this._doShell({ cmd: `taskkill /F /IM "${path.basename(args.package)}" /T`, timeout_ms: 5000 },
                               { shell: 'cmd.exe', flag: '/c' });
        }
        return { status: 'failed', error: 'args.pid or args.package required' };
      }

      case 'notify': {
        const title = String(args.title || 'Phone Bridge');
        const text = String(args.text || '');
        try {
          if (Notification.isSupported()) {
            new Notification({ title, body: text }).show();
            return { status: 'completed', result: `Notified: ${title}` };
          }
          return { status: 'completed', result: 'Notifications not supported on this system' };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      case 'download_file':
        return this._doDownloadFile(args);

      case 'upload_file':
        return this._doUploadFile(args);

      case 'execute_script':
        return this._doExecuteScript(args);

      case 'vibrate':
        process.stdout.write('\x07');
        return { status: 'completed', result: 'beep' };

      case 'flash_on': case 'flash_off':
        return { status: 'completed', result: 'no flashlight on Windows' };

      case 'broadcast':
        return { status: 'completed', result: 'broadcast not supported on Windows' };

      case 'wifi_on': case 'wifi_off': case 'wifi_status':
      case 'wifi_scan': case 'hotspot_on': case 'hotspot_off': case 'hotspot_status':
      case 'call_number': case 'send_sms':
        return { status: 'failed', error: `${command} not supported on Windows` };

      // ---- Identity + introspection ----
      case 'whoami': {
        const sm = require('./supabase-manager');
        const cfg = require('./config-store');
        return {
          status: 'completed',
          result: JSON.stringify({
            device_id: sm.getDeviceId(),
            name: sm.getDeviceName(),
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            node_version: process.version,
            username: os.userInfo().username,
            homedir: os.homedir(),
            cpus: os.cpus().length,
            total_memory_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
            uptime_seconds: Math.round(os.uptime()),
            project_ref: sm.getProjectRef(),
          }),
        };
      }

      case 'privilege': {
        return {
          status: 'completed',
          result: JSON.stringify({
            privilege_level: 'app',  // Windows: always app-level (no Shizuku)
            shizuku_uid: -1,
            can_root_shell: false,
            note: 'Windows has no equivalent of Shizuku; shell runs as the current user.',
          }),
        };
      }

      // ---- Env vars ----
      case 'env_list':
        return { status: 'completed', result: JSON.stringify(require('./config-store').getEnvVars()) };
      case 'env_get': {
        const k = String(args.key || '');
        const v = require('./config-store').getEnvVar(k);
        return { status: 'completed', result: v != null ? String(v) : null };
      }
      case 'env_set': {
        const k = String(args.key || '');
        if (!k) return { status: 'failed', error: 'args.key required' };
        require('./config-store').setEnvVar(k, args.value);
        return { status: 'completed', result: `set ${k}=${args.value}` };
      }
      case 'env_delete': {
        const k = String(args.key || '');
        if (!k) return { status: 'failed', error: 'args.key required' };
        require('./config-store').deleteEnvVar(k);
        return { status: 'completed', result: `deleted ${k}` };
      }

      // ---- Plan (save / update / get) ----
      // The agent must make a plan before acting, save it, and update it.
      // Stored as plan.md in the app userData directory.
      case 'plan_save':
      case 'plan_update': {
        const fs2 = require('fs');
        const path2 = require('path');
        const { app } = require('electron');
        const planPath = path2.join(app.getPath('userData'), 'plan.md');
        const content = String(args.content || '');
        try {
          fs2.writeFileSync(planPath, content);
          return { status: 'completed', result: `plan saved (${content.length} chars) → ${planPath}` };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }
      case 'plan_get': {
        const fs2 = require('fs');
        const path2 = require('path');
        const { app } = require('electron');
        const planPath = path2.join(app.getPath('userData'), 'plan.md');
        try {
          if (!fs2.existsSync(planPath)) {
            return { status: 'completed', result: '(no plan yet — call plan_save first)' };
          }
          return { status: 'completed', result: fs2.readFileSync(planPath, 'utf8') };
        } catch (e) { return { status: 'failed', error: e.message }; }
      }

      // ---- Skills (returns only titles — call skills_get for full content) ----
      case 'skills_list': {
        // Return only id + title (not the full content) to keep payloads small.
        const titles = this.skills.listLocal().map((e) => ({ id: e.id, title: e.title }));
        return { status: 'completed', result: JSON.stringify({ skills: titles, count: titles.length }) };
      }
      case 'skills_get': {
        const e = this.skills.getLocal(String(args.id || ''));
        if (!e) return { status: 'failed', error: 'not found' };
        return { status: 'completed', result: JSON.stringify(e) };
      }
      case 'skills_add': {
        const e = this.skills.addLocal({
          title: args.title, summary: args.summary,
          content: args.content, tags: args.tags || [],
          deviceId: require('./supabase-manager').getDeviceId(),
        });
        return { status: 'completed', result: JSON.stringify(e) };
      }
      case 'skills_update': {
        const e = this.skills.updateLocal(String(args.id || ''), {
          title: args.title, summary: args.summary,
          content: args.content, tags: args.tags,
        });
        if (!e) return { status: 'failed', error: 'not found' };
        return { status: 'completed', result: JSON.stringify(e) };
      }
      case 'skills_delete':
        this.skills.deleteLocal(String(args.id || ''));
        return { status: 'completed', result: 'deleted' };
      case 'skills_search':
        return { status: 'completed', result: JSON.stringify(this.skills.searchLocal(String(args.query || ''))) };

      // ---- Modules ----
      case 'module_list':
        return { status: 'completed', result: JSON.stringify(this.modules.listInstalled()) };
      case 'module_install': {
        if (!args.path) return { status: 'failed', error: 'args.path required (local .mdl file)' };
        const r = this.modules.install(String(args.path));
        return r;
      }
      case 'module_uninstall': {
        if (!args.name) return { status: 'failed', error: 'args.name required' };
        this.modules.uninstall(String(args.name));
        return { status: 'completed', result: 'uninstalled' };
      }

      // ---- Function catalog ----
      case 'list_functions': {
        const builtins = [
          'ping','shell','shell_ps',
          // Windows system commands
          'cmd','open_powershell','command_admin','open_process',
          'logoff','lock','shutdown','restart','abort_shutdown','sleep','hibernate',
          'open_explorer','open_control_panel','open_task_manager','open_registry_editor',
          'open_settings','empty_recycle_bin','set_volume','mute',
          // App + process management
          'open_app','close_app','list_apps','list_processes','kill_process',
          'open_url','notify','download_file','upload_file','execute_script',
          'vibrate','broadcast',
          // Identity + env
          'whoami','privilege','env_list','env_get','env_set','env_delete',
          // Plan (agent must plan first, save, update)
          'plan_save','plan_update','plan_get',
          // Skills (returns only titles — call skills_get for full content)
          'skills_list','skills_get','skills_add','skills_update','skills_delete','skills_search',
          // Modules
          'module_list','module_install','module_uninstall',
          // Control commands
          'command_stop','command_pause','command_resume','command_list_running','command_status',
        ];
        const moduleCmds = [];
        for (const m of this.modules.listInstalled()) {
          for (const c of m.commands) moduleCmds.push({ name: c, module: m.name });
        }
        return { status: 'completed', result: JSON.stringify({
          functions: builtins.map((n) => ({ name: n, source: 'builtin' })).concat(moduleCmds),
          count: builtins.length + moduleCmds.length,
        }) };
      }

      // ---- Control commands (bypass queue) ----
      case 'command_stop': {
        const stopId = Number(args.id);
        const rc = this._runningMap.get(stopId);
        if (!rc) return { status: 'completed', result: JSON.stringify({ stopped: false }) };
        if (rc.process) { try { rc.process.kill('SIGTERM'); } catch (_) {} }
        rc.status = 'stopped';
        return { status: 'completed', result: JSON.stringify({ stopped: true }) };
      }
      case 'command_pause': {
        const rc = this._runningMap.get(Number(args.id));
        if (rc) rc.paused = true;
        return { status: 'completed', result: JSON.stringify({ paused: !!rc }) };
      }
      case 'command_resume': {
        const rc = this._runningMap.get(Number(args.id));
        if (rc) rc.paused = false;
        return { status: 'completed', result: JSON.stringify({ resumed: !!rc }) };
      }
      case 'command_list_running': {
        const list = [];
        for (const rc of this._runningMap.values()) {
          list.push({ id: rc.id, command: rc.command, status: rc.status, started_at: rc.startedAt });
        }
        return { status: 'completed', result: JSON.stringify({
          running: list, count: list.length,
          queue_model: 'per-device serial (single worker)', max_concurrent: 1,
        }) };
      }
      case 'command_status': {
        const rc = this._runningMap.get(Number(args.id));
        if (!rc) return { status: 'completed', result: JSON.stringify({ running: false }) };
        return { status: 'completed', result: JSON.stringify({
          running: true, id: rc.id, command: rc.command, status: rc.status,
          running_duration_ms: Date.now() - rc.startedAt,
        }) };
      }

      default: {
        // Try a module — Windows can't execute .dex, so this will return
        // a clear error if the command is provided by a module.
        if (this.modules) {
          const modResult = this.modules.dispatch(command, args);
          if (modResult) return modResult;
        }
        return { status: 'failed', error: `unknown command: ${command}` };
      }
    }
  }

  _doShell(args, { shell, flag }) {
    const cmd = String(args.cmd || '');
    const timeoutMs = Number(args.timeout_ms || 10000);
    if (!cmd) return Promise.resolve({ status: 'failed', error: 'args.cmd required' });
    return new Promise((resolve) => {
      const child = exec(`${shell} ${flag} "${cmd.replace(/"/g, '""')}"`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const combined = (stdout || '') + (stderr || '');
        if (err && !stdout) {
          resolve({ status: 'failed', error: err.message + (combined ? '\n' + combined : '') });
        } else {
          resolve({ status: 'completed', result: combined.slice(0, 10000) });
        }
      });
      const rc = this._current;
      if (rc) { rc.process = child; }
    });
  }

  _doListApps(args) {
    const programDirs = [
      path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    ];
    const apps = [];
    for (const dir of programDirs) {
      try { if (fs.existsSync(dir)) this._scanLnk(dir, apps); } catch (_) {}
    }
    const seen = new Set();
    let unique = [];
    for (const a of apps) {
      const key = a.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); unique.push(a);
    }
    if (args.label_query) {
      const q = String(args.label_query).toLowerCase();
      unique = unique.filter((a) => a.name.toLowerCase().includes(q));
    }
    if (args.package_prefix) {
      const p = String(args.package_prefix).toLowerCase();
      unique = unique.filter((a) => a.package.toLowerCase().startsWith(p));
    }
    const limit = Number(args.limit || 200);
    return { status: 'completed', result: JSON.stringify({ apps: unique.slice(0, limit), count: unique.length }) };
  }

  _scanLnk(dir, out) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) this._scanLnk(full, out);
        else if (e.name.toLowerCase().endsWith('.lnk')) {
          out.push({ name: e.name.replace(/\.lnk$/i, ''), package: full, system: dir.startsWith('C:\\ProgramData') });
        }
      }
    } catch (_) {}
  }

  _doDownloadFile(args) {
    const url = String(args.url || '');
    const dest = String(args.path || '');
    const timeoutMs = Number(args.timeout_ms || 60000);
    if (!url || !dest) return Promise.resolve({ status: 'failed', error: 'args.url + args.path required' });
    return new Promise((resolve) => {
      try {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            this._doDownloadFile({ url: res.headers.location, path: dest, timeout_ms: timeoutMs }).then(resolve);
            return;
          }
          if (res.statusCode !== 200) { resolve({ status: 'failed', error: 'HTTP ' + res.statusCode }); return; }
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}
          const ws = fs.createWriteStream(dest);
          res.pipe(ws);
          ws.on('finish', () => {
            ws.close();
            resolve({ status: 'completed', result: `Downloaded ${url} → ${dest} (${fs.statSync(dest).size} bytes)` });
          });
          ws.on('error', (e) => resolve({ status: 'failed', error: 'write error: ' + e.message }));
        });
        req.on('error', (e) => resolve({ status: 'failed', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 'failed', error: 'timeout' }); });
      } catch (e) { resolve({ status: 'failed', error: e.message }); }
    });
  }

  async _doUploadFile(args) {
    const filePath = String(args.path || '');
    if (!filePath) return { status: 'failed', error: 'args.path required' };
    if (!fs.existsSync(filePath)) return { status: 'failed', error: 'file not found: ' + filePath };
    try {
      const r = await this.client.uploadFile({ path: filePath, name: args.name });
      if (r.status >= 200 && r.status < 300) {
        return { status: 'completed', result: `Uploaded ${filePath}` };
      }
      return { status: 'failed', error: `HTTP ${r.status}: ${r.body}` };
    } catch (e) { return { status: 'failed', error: e.message }; }
  }

  async _doExecuteScript(args) {
    const commands = args.commands || [];
    if (!Array.isArray(commands)) return { status: 'failed', error: 'args.commands must be an array' };
    const results = [];
    for (const sub of commands) {
      const subCommand = String(sub.command || '');
      const subArgs = sub.args || {};
      try {
        const r = await this._dispatch(subCommand, subArgs, null);
        results.push({ command: subCommand, status: r.status, result: r.result, error: r.error });
      } catch (e) {
        results.push({ command: subCommand, status: 'failed', error: e.message });
      }
    }
    return { status: 'completed', result: JSON.stringify(results) };
  }
}

module.exports = { CommandExecutor };
