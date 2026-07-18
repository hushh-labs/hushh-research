#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_MARKERS = [
  "README.md",
  "contributing.md",
  "bin",
  "scripts/env",
  "hushh-webapp",
  "consent-protocol",
];

const DEFAULT_PATHS = {
  repoRoot: "",
  webappRoot: "hushh-webapp",
  consentProtocolRoot: "consent-protocol",
  scriptsEnvRoot: "scripts/env",
};

function usage() {
  console.log(`Usage:
  node scripts/env/env-preflight.mjs [--json]

Description:
  Validates local repository path configuration before bootstrap or doctor
  commands spend time on deeper setup checks.

Environment overrides:
  HUSHH_REPO_ROOT
  HUSHH_WEBAPP_ROOT
  HUSHH_CONSENT_PROTOCOL_ROOT
  HUSHH_SCRIPTS_ENV_ROOT`);
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathExists(target, kind) {
  try {
    const stat = fs.statSync(target);
    if (!kind) return true;
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

function findRepoRoot(start) {
  let current = path.resolve(start);

  while (true) {
    const hasMarkers = REPO_MARKERS.every((marker) => pathExists(path.join(current, marker)));
    if (hasMarkers) return current;

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate Hussh repository root from ${start}`);
    }
    current = parent;
  }
}

function resolveConfiguredPath(repoRoot, envKey, fallbackRelativePath) {
  const value = process.env[envKey]?.trim();
  if (!value) return path.resolve(repoRoot, fallbackRelativePath);
  return path.resolve(value);
}

function check(key, ok, detail, remediation) {
  return { key, ok, detail, remediation };
}

function renderText(checks) {
  for (const item of checks) {
    const label = item.ok ? "PASS" : "FAIL";
    console.log(`${label} ${item.key}: ${item.detail}`);
    if (!item.ok && item.remediation) {
      console.log(`     fix: ${item.remediation}`);
    }
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("-h") || args.has("--help")) {
    usage();
    return;
  }

  const json = args.has("--json");
  const repoRoot = path.resolve(process.env.HUSHH_REPO_ROOT?.trim() || findRepoRoot(process.cwd()));
  const webappRoot = resolveConfiguredPath(
    repoRoot,
    "HUSHH_WEBAPP_ROOT",
    DEFAULT_PATHS.webappRoot,
  );
  const consentProtocolRoot = resolveConfiguredPath(
    repoRoot,
    "HUSHH_CONSENT_PROTOCOL_ROOT",
    DEFAULT_PATHS.consentProtocolRoot,
  );
  const scriptsEnvRoot = resolveConfiguredPath(
    repoRoot,
    "HUSHH_SCRIPTS_ENV_ROOT",
    DEFAULT_PATHS.scriptsEnvRoot,
  );

  const configuredRoots = [
    ["hushh-webapp", webappRoot],
    ["consent-protocol", consentProtocolRoot],
    ["scripts/env", scriptsEnvRoot],
  ];

  const overlapChecks = [];
  for (let i = 0; i < configuredRoots.length; i += 1) {
    for (let j = i + 1; j < configuredRoots.length; j += 1) {
      const [leftName, leftPath] = configuredRoots[i];
      const [rightName, rightPath] = configuredRoots[j];
      const overlaps =
        samePath(leftPath, rightPath) ||
        isInside(leftPath, rightPath) ||
        isInside(rightPath, leftPath);
      overlapChecks.push(
        check(
          `no_overlap_${leftName}_and_${rightName}`.replace(/[^a-z0-9_]+/gi, "_"),
          !overlaps,
          `${leftPath} :: ${rightPath}`,
          `Keep ${leftName} and ${rightName} as separate repository subpaths.`,
        ),
      );
    }
  }

  const checks = [
    check(
      "repo_root_exists",
      pathExists(repoRoot),
      repoRoot,
      "Set HUSHH_REPO_ROOT to the hushh-research checkout root.",
    ),
    check(
      "repo_root_markers",
      REPO_MARKERS.every((marker) => pathExists(path.join(repoRoot, marker))),
      `expected markers: ${REPO_MARKERS.join(", ")}`,
      "Run this command from the hushh-research checkout root.",
    ),
    check(
      "webapp_root_exists",
      pathExists(webappRoot),
      webappRoot,
      "Set HUSHH_WEBAPP_ROOT to the hushh-webapp directory.",
    ),
    check(
      "consent_protocol_root_exists",
      pathExists(consentProtocolRoot),
      consentProtocolRoot,
      "Set HUSHH_CONSENT_PROTOCOL_ROOT to the consent-protocol directory.",
    ),
    check(
      "scripts_env_root_exists",
      pathExists(scriptsEnvRoot),
      scriptsEnvRoot,
      "Set HUSHH_SCRIPTS_ENV_ROOT to scripts/env.",
    ),
    check(
      "webapp_inside_repo",
      isInside(repoRoot, webappRoot),
      webappRoot,
      "Keep hushh-webapp inside the monorepo root.",
    ),
    check(
      "consent_protocol_inside_repo",
      isInside(repoRoot, consentProtocolRoot),
      consentProtocolRoot,
      "Keep consent-protocol inside the monorepo root.",
    ),
    check(
      "scripts_env_inside_repo",
      isInside(repoRoot, scriptsEnvRoot),
      scriptsEnvRoot,
      "Keep scripts/env inside the monorepo root.",
    ),
    ...overlapChecks,
    check(
      "webapp_package_contract",
      pathExists(path.join(webappRoot, "package.json"), "file"),
      path.join(webappRoot, "package.json"),
      "Restore hushh-webapp/package.json or correct HUSHH_WEBAPP_ROOT.",
    ),
    check(
      "consent_protocol_pyproject_contract",
      pathExists(path.join(consentProtocolRoot, "pyproject.toml"), "file"),
      path.join(consentProtocolRoot, "pyproject.toml"),
      "Restore consent-protocol/pyproject.toml or correct HUSHH_CONSENT_PROTOCOL_ROOT.",
    ),
    check(
      "doctor_script_contract",
      pathExists(path.join(scriptsEnvRoot, "doctor.sh"), "file"),
      path.join(scriptsEnvRoot, "doctor.sh"),
      "Restore scripts/env/doctor.sh or correct HUSHH_SCRIPTS_ENV_ROOT.",
    ),
  ];

  const failures = checks.filter((item) => !item.ok);
  if (json) {
    console.log(
      JSON.stringify(
        {
          status: failures.length === 0 ? "pass" : "fail",
          repoRoot,
          webappRoot,
          consentProtocolRoot,
          scriptsEnvRoot,
          checks,
        },
        null,
        2,
      ),
    );
  } else {
    renderText(checks);
    console.log("");
    console.log(
      failures.length === 0
        ? "Environment preflight passed."
        : `Environment preflight failed with ${failures.length} issue(s).`,
    );
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`FAIL env_preflight: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
