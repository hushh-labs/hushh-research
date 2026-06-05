#!/usr/bin/env node

const path = require("node:path");

const {
  CONFIG_RESOURCES,
  resolveWorkspaceAsset,
  workspaceRoot,
} = require("./workspace-setup");

function assert(condition, message) {
  if (!condition) {
    console.error(`Workspace setup smoke failed: ${message}`);
    process.exit(1);
  }
}

const expectedRoot = path.resolve(__dirname, "..");

assert(workspaceRoot === expectedRoot, "workspaceRoot should resolve to the repository root");
assert(
  resolveWorkspaceAsset("data/fixtures") === path.join(expectedRoot, "data", "fixtures"),
  "data/fixtures should resolve under the repository root"
);
assert(
  CONFIG_RESOURCES.tmpDirectory === path.join(expectedRoot, "tmp"),
  "tmpDirectory should resolve under the repository root"
);
assert(
  !path.isAbsolute(path.relative(expectedRoot, CONFIG_RESOURCES.pkmCacheDirectory)),
  "pkmCacheDirectory should remain inside the repository root"
);

console.log("Workspace setup smoke passed: resource paths resolve from the repository root.");
