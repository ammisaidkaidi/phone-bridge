// src/knowledge-manager.js
//
// Knowledge + skills dual-storage: each entry exists locally as a .md
// file (knowledge/ or skills/ subdir under app.getPath('userData'))
// AND in the Supabase DB (knowledge / skills tables). Sync direction:
//   • DB → local: every 5 min via the knowledge-sync / skills-sync edge
//     functions (so entries created on other devices appear on this one).
//   • local → DB: when the user (or an AI agent) calls knowledge_add /
//     skills_add, we write the local file AND push to DB.
//
// Mirror of Android's KnowledgeManager.java.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

class KnowledgeManager {
  constructor({ client, kind = 'knowledge', onLog } = {}) {
    if (!['knowledge', 'skills'].includes(kind)) {
      throw new Error('kind must be "knowledge" or "skills"');
    }
    this.client = client;
    this.kind = kind;
    this.onLog = onLog || ((m) => console.log(m));
    this.dir = path.join(app.getPath('userData'), kind);
    this.indexFile = path.join(this.dir, 'index.json');
    this._syncTimer = null;
    this._ensureDir();
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    if (!fs.existsSync(this.indexFile)) {
      this._writeIndex({ entries: [] });
    }
  }

  _readIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); }
    catch (_) { return { entries: [] }; }
  }

  _writeIndex(idx) {
    try { fs.writeFileSync(this.indexFile, JSON.stringify(idx, null, 2)); } catch (e) { this.onLog(`writeIndex: ${e.message}`, 'warn'); }
  }

  // ---- Local CRUD ----
  listLocal() {
    return this._readIndex().entries || [];
  }

  getLocal(id) {
    const entry = this.listLocal().find((e) => e.id === id);
    if (!entry) return null;
    try {
      const content = fs.readFileSync(path.join(this.dir, `${id}.md`), 'utf8');
      return Object.assign({}, entry, { content });
    } catch (_) { return null; }
  }

  addLocal({ title, summary = '', content, tags = [], deviceId = null }) {
    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const entry = {
      id, title, summary, tags,
      created_at: now, updated_at: now,
      author_device_id: deviceId,
    };
    fs.writeFileSync(path.join(this.dir, `${id}.md`), content);
    const idx = this._readIndex();
    idx.entries.push(entry);
    this._writeIndex(idx);
    return entry;
  }

  updateLocal(id, { title, summary, content, tags }) {
    const idx = this._readIndex();
    const e = idx.entries.find((e) => e.id === id);
    if (!e) return null;
    if (title   !== undefined) e.title = title;
    if (summary !== undefined) e.summary = summary;
    if (tags    !== undefined) e.tags = tags;
    e.updated_at = new Date().toISOString();
    if (content !== undefined) {
      fs.writeFileSync(path.join(this.dir, `${id}.md`), content);
    }
    this._writeIndex(idx);
    return e;
  }

  deleteLocal(id) {
    const idx = this._readIndex();
    idx.entries = idx.entries.filter((e) => e.id !== id);
    this._writeIndex(idx);
    try { fs.unlinkSync(path.join(this.dir, `${id}.md`)); } catch (_) {}
  }

  searchLocal(query) {
    const q = query.toLowerCase();
    return this.listLocal().filter((e) => {
      return (e.title || '').toLowerCase().includes(q)
          || (e.summary || '').toLowerCase().includes(q)
          || (e.tags || []).some((t) => String(t).toLowerCase().includes(q));
    });
  }

  // ---- DB sync (DB → local) ----
  async syncFromDb() {
    try {
      const fn = this.kind === 'knowledge' ? 'knowledgeSync' : 'skillsSync';
      const { status, body } = await this.client[fn]();
      if (status >= 400) {
        this.onLog(`${this.kind} sync failed: HTTP ${status}`, 'warn'); return;
      }
      const entries = (body && body.entries) || [];
      let added = 0, updated = 0;
      for (const remote of entries) {
        const local = this.getLocal(remote.id);
        if (!local) {
          // New — write it.
          this.addLocal({
            title: remote.title, summary: remote.summary || '',
            content: remote.content || '', tags: remote.tags || [],
            deviceId: remote.author_device_id,
          });
          // Overwrite the auto-generated id with the remote id.
          const idx = this._readIndex();
          const last = idx.entries[idx.entries.length - 1];
          if (last) {
            last.id = remote.id;
            last.created_at = remote.created_at;
            last.updated_at = remote.updated_at;
            this._writeIndex(idx);
            // Rename the .md file.
            try {
              fs.renameSync(
                path.join(this.dir, `${last.id}.slice(-32)}.md`),
                path.join(this.dir, `${remote.id}.md`)
              );
            } catch (_) {}
          }
          added++;
        } else if (new Date(remote.updated_at) > new Date(local.updated_at)) {
          this.updateLocal(remote.id, {
            title: remote.title, summary: remote.summary,
            content: remote.content, tags: remote.tags,
          });
          updated++;
        }
      }
      this.onLog(`${this.kind} sync: ${added} new, ${updated} updated, ${entries.length} total`, 'info');
    } catch (e) {
      this.onLog(`${this.kind} sync error: ${e.message}`, 'warn');
    }
  }

  startPeriodicSync(intervalMs = 5 * 60 * 1000) {
    if (this._syncTimer) return;
    this.syncFromDb();  // immediate first sync
    this._syncTimer = setInterval(() => this.syncFromDb(), intervalMs);
    if (this._syncTimer.unref) this._syncTimer.unref();
    this.onLog(`${this.kind} periodic sync started (every ${Math.round(intervalMs / 1000 / 60)} min)`, 'info');
  }

  stopPeriodicSync() {
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
  }
}

module.exports = { KnowledgeManager };
