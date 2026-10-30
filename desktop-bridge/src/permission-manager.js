// src/permission-manager.js
//
// Per-command DENY / ASK / ALLOW gate. Mirror of Android's
// PermissionManager.java — but WITHOUT the interactive-notification
// flow (Windows: ASK is treated as ALLOW by default since the desktop
// UI is always visible; the user can switch to DENY via the Permissions
// tab to block specific commands).
//
// Decisions are stored in config-store.js → permissions: { "<cmd>": "ALLOW"|"ASK"|"DENY" }.

'use strict';

const config = require('./config-store');

const DECISION = { ALLOW: 'ALLOW', ASK: 'ASK', DENY: 'DENY' };

function getDecision(command) {
  return config.getPermission(command) || DECISION.ALLOW;
}

function setDecision(command, decision) {
  if (!Object.values(DECISION).includes(decision)) {
    throw new Error('invalid decision: ' + decision);
  }
  config.setPermission(command, decision);
}

function getAll() {
  return config.getAllPermissions();
}

module.exports = { DECISION, getDecision, setDecision, getAll };
