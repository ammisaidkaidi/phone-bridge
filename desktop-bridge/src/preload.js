// src/preload.js
// contextBridge — exposes window.bridge.* to the renderer.
// contextIsolation is on; renderer can't touch Node directly.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // Config + setup
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (p) => ipcRenderer.invoke('config:set', p),
  setupRun: (pat) => ipcRenderer.invoke('setup:run', pat),
  setupRedeployFns: () => ipcRenderer.invoke('setup:redeploy-fns'),
  setupCopySql: () => ipcRenderer.invoke('setup:copy-sql'),

  // Bridge lifecycle
  bridgeConnect: () => ipcRenderer.invoke('bridge:connect'),
  bridgeDisconnect: () => ipcRenderer.invoke('bridge:disconnect'),
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),

  // Commands
  commandsList: (opts) => ipcRenderer.invoke('commands:list', opts),
  commandsClear: () => ipcRenderer.invoke('commands:clear'),
  commandsDelete: (id) => ipcRenderer.invoke('commands:delete', id),
  commandsMark: (opts) => ipcRenderer.invoke('commands:mark', opts),

  // Test + discovery
  testPing: () => ipcRenderer.invoke('test:ping'),
  devicesList: () => ipcRenderer.invoke('devices:list'),
  functionsList: () => ipcRenderer.invoke('functions:list'),
  aiPromptGet: () => ipcRenderer.invoke('ai-prompt:get'),

  // Permissions
  permsGetAll: () => ipcRenderer.invoke('perms:get-all'),
  permsSet: (command, decision) => ipcRenderer.invoke('perms:set', { command, decision }),

  // Modules
  modulesList: () => ipcRenderer.invoke('modules:list'),
  modulesInstallFromPath: (filePath) => ipcRenderer.invoke('modules:install-from-path', filePath),
  modulesUninstall: (name) => ipcRenderer.invoke('modules:uninstall', name),

  // Knowledge
  knowledgeList: () => ipcRenderer.invoke('knowledge:list'),
  knowledgeGet: (id) => ipcRenderer.invoke('knowledge:get', id),
  knowledgeAdd: (opts) => ipcRenderer.invoke('knowledge:add', opts),
  knowledgeUpdate: (opts) => ipcRenderer.invoke('knowledge:update', opts),
  knowledgeDelete: (id) => ipcRenderer.invoke('knowledge:delete', id),
  knowledgeSearch: (q) => ipcRenderer.invoke('knowledge:search', q),
  knowledgeSync: () => ipcRenderer.invoke('knowledge:sync'),

  // Skills
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsGet: (id) => ipcRenderer.invoke('skills:get', id),
  skillsAdd: (opts) => ipcRenderer.invoke('skills:add', opts),
  skillsUpdate: (opts) => ipcRenderer.invoke('skills:update', opts),
  skillsDelete: (id) => ipcRenderer.invoke('skills:delete', id),
  skillsSearch: (q) => ipcRenderer.invoke('skills:search', q),
  skillsSync: () => ipcRenderer.invoke('skills:sync'),

  // Env vars
  envList: () => ipcRenderer.invoke('env:list'),
  envSet: (key, value) => ipcRenderer.invoke('env:set', { key, value }),
  envDelete: (key) => ipcRenderer.invoke('env:delete', key),

  // Terminal server
  terminalStart: () => ipcRenderer.invoke('terminal:start'),
  terminalStop: () => ipcRenderer.invoke('terminal:stop'),
  terminalStatus: () => ipcRenderer.invoke('terminal:status'),

  // Shell
  shellOpenExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Credential tests
  testUrl:        (url)    => ipcRenderer.invoke('test:url', url),
  testPublishable: (opts)  => ipcRenderer.invoke('test:publishable', opts),
  testSecret:      (key)   => ipcRenderer.invoke('test:secret', key),
  testPAT:         (pat)   => ipcRenderer.invoke('test:pat', pat),
  testAll:         (opts)  => ipcRenderer.invoke('test:all', opts),

  // Events
  onStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('bridge:status', h);
    return () => ipcRenderer.removeListener('bridge:status', h);
  },
  onLog: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('log', h);
    return () => ipcRenderer.removeListener('log', h);
  },
});
