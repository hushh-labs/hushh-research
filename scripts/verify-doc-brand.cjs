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

// Files whose USER-FACING copy must spell the brand "Hussh", checked with a
// case-INSENSITIVE rule.
//
// The `targets` sweep above only looks for capitalised `Hushh`, which is why the
// connection-request notification shipped "wants to connect with you on hushh."
// for the life of that surface and the gate reported OK the whole time
// (issue #5422). These files carry notification/toast prose, so the lowercase
// form is a defect there specifically -- as opposed to the rest of the repo,
// where lowercase `hushh` is a legitimate identifier.
//
// Adding a file here is a commitment that it contains no bare lowercase brand
// token. Identifiers (domains, bundle ids, message-type namespaces, module and
// repo names) are stripped before the check, so they remain safe to use.
const proseTargets = [
  "hushh-webapp/components/consent/notification-provider.tsx",
  "hushh-webapp/public/firebase-messaging-sw.js",
  "consent-protocol/hushh_mcp/services/push_notifications.py",
];

// Occurrences that are identifiers, not prose. These are removed from a line
// before it is tested, so a line may legitimately contain them. Deliberately not
// a line-level skip: that would let real prose hide on the same line as a URL.
// Every pattern must require an adjoining identifier character. A pattern that
// can match a BARE `hushh` (e.g. `[\w-]*hushh[\w-]*`, whose quantifiers both
// accept empty) silently erases the defect this rule exists to find — verified
// by the self-test below, which is why that self-test is not optional.
const infraBrandTokenPatterns = [
  /hushh:\/\//g, // MCP resource URIs
  /hushh:[a-z_]+/g, // service-worker postMessage types, e.g. hushh:fcm_push_ack
  /[\w.-]*hushh\.(?:ai|app|local)/g, // domains: hushh.ai, one.hushh.ai, hushh.local
  /hush1one\.com/g,
  /com\.hushh[\w.]*/g, // bundle identifiers
  /com\.hussh[\w.]*/g,
  /[@/-]hushh[\w/-]*/g, // @hushh/mcp, x-hushh-client-version, /hushh-webapp
  /hushh[-/][\w./-]*/g, // hushh-webapp, hushh-research, hushh/path
  // `hushh_mcp`, `HUSHH_*` and `/hushh_icon.png` need no pattern: `_` is a word
  // character, so `\bhushh\b` cannot match them.
];

const allowedBrandPatterns = [
  /\bHushh(?:Vault|Consent|Notifications|Account|Sync|Auth|Keystore|Keychain|Database|Loader|Voice|Runtime|MCP|ProxyClient)\b/,
  /\bHushh Engineering Core\b/,
  /\bHushhMCP\b/,
  /\bX-Hushh-[A-Za-z-]+\b/,
  /\bcom\.hushh\./,
  // GitHub Projects board Sector option values (external state; the scripts
  // must emit the exact strings configured on the board).
  /\bHushh (?:Research|AI)\b/,
  /\bHushhTech\b/,
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

/**
 * The line with every identifier-shaped brand token removed, so what remains is
 * prose. `hushh_mcp` needs no pattern: `_` is a word character, so `\bhushh\b`
 * never matches it in the first place.
 */
function stripInfraBrandTokens(line) {
  return infraBrandTokenPatterns.reduce(
    (residual, pattern) => residual.replace(pattern, ""),
    line,
  );
}

/**
 * Prove the prose rule still has teeth before trusting it.
 *
 * A gate that cannot fail is worse than no gate: it reports OK and everyone
 * believes the invariant holds. The original brand check did exactly that here —
 * it was case-sensitive, so the reported string was invisible to it.
 */
function selfTestProseRule() {
  const mustFail = [
    'BODY = "Someone wants to connect with you on hushh."',
    "<p>wants to connect with you on hushh.</p>",
    'title = "Welcome to Hushh"',
  ];
  const mustPass = [
    'const url = "https://one.hushh.ai/one/consent";',
    'type: "hushh:fcm_push_received",',
    'from hushh_mcp.branding import connection_request_body',
    'icon: "/hushh_icon.png",',
    'appId: "com.hushh.app",',
    'headers: { "x-hushh-client-version": "1" },',
    '// see hushh-webapp/lib/branding/brand.ts and hushh-research docs',
    'BODY = "Someone wants to connect with you on Hussh."',
  ];

  const problems = [];
  for (const line of mustFail) {
    if (!/\bhushh\b/i.test(stripInfraBrandTokens(line))) {
      problems.push(`prose rule failed to flag: ${line}`);
    }
  }
  for (const line of mustPass) {
    if (/\bhushh\b/i.test(stripInfraBrandTokens(line))) {
      problems.push(`prose rule wrongly flagged an identifier: ${line}`);
    }
  }
  return problems;
}

function main() {
  const files = [...new Set(targets.flatMap((target) => walk(target)))].sort();
  const failures = [...selfTestProseRule()];

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

  for (const relFile of [...new Set(proseTargets)].sort()) {
    const absolute = path.join(repoRoot, relFile);
    if (!fs.existsSync(absolute)) {
      failures.push(
        `${relFile}: listed in proseTargets but missing — re-point or remove it`,
      );
      continue;
    }
    const lines = fs.readFileSync(absolute, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/\bhushh\b/i.test(stripInfraBrandTokens(lines[i]))) {
        failures.push(
          `${relFile}:${i + 1}: user-facing copy must spell the brand "Hussh"`,
        );
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
