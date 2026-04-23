#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirs = new Set([
  "node_modules",
  ".next",
  "DerivedData",
  ".pytest_cache",
  ".git",
  ".venv",
  "dist",
  "build",
  "__pycache__",
]);

const targets = [
  "README.md",
  "getting_started.md",
  "TESTING.md",
  "contributing.md",
  "docs",
  "consent-protocol/docs",
  "hushh-webapp/docs",
  "packages/hushh-mcp/README.md",
  "packages/hushh-mcp/NOTICE",
  "packages/hushh-mcp/package.json",
  "packages/hushh-mcp/scripts/render-readme.mjs",
  "packages/hushh-mcp/bin/hushh-mcp.js",
  "consent-protocol/README.md",
  "consent-protocol/mcp_server.py",
  "consent-protocol/setup_mcp.py",
  "consent-protocol/api/routes/developer.py",
  "consent-protocol/api/routes/session.py",
  "consent-protocol/mcp_modules/resources.py",
  "consent-protocol/mcp_modules/tools/consent_tools.py",
  "consent-protocol/mcp_modules/tools/data_tools.py",
  "consent-protocol/mcp_modules/tools/definitions.py",
  "consent-protocol/hushh_mcp/services/developer_registry_service.py",
  "hushh-webapp/README.md",
  "hushh-webapp/lib/developers/content.ts",
  "hushh-webapp/app/globals.css",
  "hushh-webapp/components/vault/vault-flow.tsx",
  "hushh-webapp/components/vault/vault-method-prompt.tsx",
  "hushh-webapp/components/vault/recovery-key-dialog.tsx",
  "hushh-webapp/app/profile/page.tsx",
  ".codex/skills/codex-skill-authoring/scripts/init_skill.py",
  ".codex/skills/repo-context/scripts/repo_scan.py",
  ".codex/skills/repo-operations/scripts/ci_monitor.py",
  ".codex/skills",
  ".codex/workflows",
];

const allowedBrandPatterns = [
  /\bHushh(?:Vault|Consent|Notifications|Account|Sync|Auth|Keystore|Keychain|Database|Loader|Voice|Runtime|MCP|ProxyClient)\b/,
  /\bHushh Engineering Core\b/,
  /\bHushhMCP\b/,
  /\bX-Hushh-[A-Za-z-]+\b/,
  /\bcom\.hushh\./,
];

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function walk(relTarget) {
  const absTarget = path.join(repoRoot, relTarget);
  if (!fs.existsSync(absTarget)) return [];
  const stat = fs.statSync(absTarget);

  if (stat.isFile()) return [normalize(relTarget)];

  const out = [];

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        entry.name.endsWith(".md") ||
        entry.name === "SKILL.md" ||
        entry.name === "PLAYBOOK.md" ||
        entry.name.endsWith(".json") ||
        entry.name.endsWith(".js") ||
        entry.name.endsWith(".cjs") ||
        entry.name.endsWith(".mjs") ||
        entry.name.endsWith(".py") ||
        entry.name.endsWith(".ts") ||
        entry.name.endsWith(".tsx") ||
        entry.name.endsWith(".css") ||
        entry.name === "NOTICE"
      ) {
        out.push(normalize(path.relative(repoRoot, full)));
      }
    }
  };

  visit(absTarget);
  return out;
}

function stripMarkdownCode(source) {
  return source
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/^---[\s\S]*?---\s*/m, "");
}

function loadComparableText(relFile) {
  const raw = fs.readFileSync(path.join(repoRoot, relFile), "utf8");
  if (relFile.endsWith(".md")) return stripMarkdownCode(raw);
  return raw;
}

function isAllowedBrandLine(line) {
  return allowedBrandPatterns.some((pattern) => pattern.test(line));
}

function main() {
  const files = [...new Set(targets.flatMap((target) => walk(target)))].sort();
  const failures = [];

  for (const relFile of files) {
    const comparable = loadComparableText(relFile);
    if (!/\bHushh\b/.test(comparable)) continue;

    const lines = comparable.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/\bHushh\b/.test(lines[i]) && !isAllowedBrandLine(lines[i])) {
        failures.push(`${relFile}:${i + 1}: stray standalone Hushh branding`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("ERROR: docs brand check failed");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("OK: docs brand check passed");
}

main();
