#!/usr/bin/env node

const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");

function resolveWorkspaceAsset(relativeTarget = "") {
  return path.resolve(workspaceRoot, relativeTarget);
}

const CONFIG_RESOURCES = {
  workspaceRoot,
  mockProfileDirectory: resolveWorkspaceAsset("data/fixtures"),
  pkmCacheDirectory: resolveWorkspaceAsset(".pkm_cache"),
  consentLogPath: resolveWorkspaceAsset("logs/consent_audit.log"),
  tmpDirectory: resolveWorkspaceAsset("tmp"),
};

if (require.main === module) {
  console.log("Workspace path mappings initialized relative to repository root.");
  for (const [key, value] of Object.entries(CONFIG_RESOURCES)) {
    console.log(`${key}: ${value}`);
  }
}

module.exports = {
  CONFIG_RESOURCES,
  resolveWorkspaceAsset,
  workspaceRoot,
};
