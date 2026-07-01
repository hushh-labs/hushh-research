"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Basic .env parser.
 * @param {string} filePath 
 * @returns {Record<string, string>}
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  content.split("\n").forEach((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      let key = match[1];
      let value = match[2] || "";
      // Strip outer quotes if present
      if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        value = value.replace(/\\n/gm, "\n").replace(/\\"/gm, '"').slice(1, -1);
      } else if (value.length > 0 && value.charAt(0) === "'" && value.charAt(value.length - 1) === "'") {
        value = value.slice(1, -1);
      }
      env[key] = value.trim();
    }
  });
  return env;
}

/**
 * Resolves environmental variables for the frontend and backend processes.
 * @param {string} frontendCwd 
 * @param {string} backendCwd 
 * @returns {{ frontendEnv: Record<string, string>, backendEnv: Record<string, string> }}
 */
function resolveEnvironments(frontendCwd, backendCwd) {
  const frontendEnv = {
    ...loadEnvFile(path.join(frontendCwd, ".env.production")),
    ...loadEnvFile(path.join(frontendCwd, ".env")),
    ...loadEnvFile(path.join(frontendCwd, ".env.local")),
  };

  const backendEnv = loadEnvFile(path.join(backendCwd, ".env"));

  return {
    frontendEnv,
    backendEnv,
  };
}

module.exports = {
  loadEnvFile,
  resolveEnvironments,
};
