// src/module-manager.js
//
// .mdl module catalog. Each module is a ZIP archive containing
// manifest.json + classes.dex + optional <name>.so. On Android, these
// are loaded via DexClassLoader. On Windows we can't execute Dalvik
// bytecode, so this manager is a metadata-only catalog: it tracks which
// modules are installed and what commands they would expose, but
// dispatching to a module command returns "module execution not
// supported on Windows".
//
// Mirror of Android's ModuleManager.java, minus the DexClassLoader part.

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ModuleManager {
  constructor({ client, onLog } = {}) {
    this.client = client;
    this.onLog = onLog || ((m) => console.log(m));
    this.dir = path.join(app.getPath('userData'), 'modules');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    this.modules = [];  // [{name, version, commands, manifest}]
    this._loadInstalled();
  }

  _loadInstalled() {
    this.modules = [];
    try {
      const files = fs.readdirSync(this.dir);
      for (const f of files) {
        if (!f.endsWith('.mdl')) continue;
        try {
          const full = path.join(this.dir, f);
          // .mdl is a ZIP — read manifest.json from inside without extracting.
          const manifest = this._readMdlManifest(full);
          if (manifest) {
            this.modules.push({
              name: manifest.name || f.replace(/\.mdl$/, ''),
              version: manifest.version || '0.0.0',
              type: manifest.type || 'dex',
              commands: manifest.commands || [],
              manifest,
              file: full,
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  _readMdlManifest(filepath) {
    // .mdl is a ZIP. Read the manifest.json entry without extracting.
    // We use Node's built-in zlib + a minimal ZIP central-directory parser.
    // For simplicity, defer to the `unzip` command if available; else
    // skip (modules are best-effort on Windows).
    try {
      const { execSync } = require('child_process');
      const out = execSync(`unzip -p "${filepath}" manifest.json`, { encoding: 'utf8', timeout: 5000 });
      return JSON.parse(out);
    } catch (_) {
      return null;
    }
  }

  listInstalled() {
    return this.modules.map((m) => ({
      name: m.name, version: m.version, type: m.type,
      commands: m.commands.map((c) => c.name || c.command || c),
      file: m.file,
    }));
  }

  /**
   * Install a .mdl from a local path or Buffer.
   * Returns { ok, name, version, commands }.
   */
  install(filepathOrBuffer, originalName) {
    const name = (originalName || 'module.mdl').replace(/\.mdl$/, '') + '.mdl';
    const dest = path.join(this.dir, name);
    try {
      if (Buffer.isBuffer(filepathOrBuffer)) {
        fs.writeFileSync(dest, filepathOrBuffer);
      } else {
        fs.copyFileSync(filepathOrBuffer, dest);
      }
      const manifest = this._readMdlManifest(dest);
      if (!manifest) {
        return { ok: false, error: 'manifest.json not found inside .mdl' };
      }
      this._loadInstalled();
      return {
        ok: true,
        name: manifest.name || name.replace(/\.mdl$/, ''),
        version: manifest.version || '0.0.0',
        commands: manifest.commands || [],
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  uninstall(name) {
    const file = path.join(this.dir, `${name}.mdl`);
    try { fs.unlinkSync(file); } catch (_) {}
    this._loadInstalled();
    return { ok: true };
  }

  /** Try to dispatch a command via an installed module.
   * On Windows this always returns "not supported". */
  dispatch(command, args) {
    for (const m of this.modules) {
      for (const c of m.commands) {
        const cname = typeof c === 'string' ? c : (c.name || c.command);
        if (cname === command) {
          return {
            ok: false,
            error: `command "${command}" is provided by module "${m.name}" ` +
                   `which cannot be executed on Windows (Dalvik bytecode)`,
          };
        }
      }
    }
    return null;  // not handled by any module
  }
}

module.exports = { ModuleManager };
