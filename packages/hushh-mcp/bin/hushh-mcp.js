#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const packageDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
);
const packageName = packageJson.name;
const packageVersion = packageJson.version;
const isWindows = process.platform === "win32";
const args = process.argv.slice(2);

function printUsage() {
  console.log(`${packageName} ${packageVersion}`);
  console.log("");
  console.log("Bootstrap and run the existing Hushh Python MCP server.");
  console.log("");
  console.log("Usage:");
  console.log("  hushh-mcp");
  console.log("  hushh-mcp --print-config");
  console.log("  hushh-mcp --print-codex-toml");
  console.log("  hushh-mcp --print-remote-config");
  console.log("");
  console.log("Environment:");
  console.log("  HUSHH_MCP_ENV_FILE      Optional path to a consent-protocol style .env file");
  console.log("  HUSHH_MCP_RUNTIME_DIR   Optional path to a consent-protocol runtime");
  console.log("  HUSHH_MCP_CACHE_DIR     Optional bootstrap cache directory");
  console.log("  HUSHH_MCP_PYTHON        Optional base Python interpreter for bootstrap");
  console.log("  CONSENT_API_URL         Backend origin for consent API and MCP calls");
  console.log("  HUSHH_DEVELOPER_TOKEN   Self-serve developer token used by stdio MCP");
  console.log("  HUSHH_MCP_SKIP_BOOTSTRAP  Set to 1 to skip venv creation and pip install");
}

function printConfig() {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "hushh-consent": {
            command: "npx",
            args: ["-y", "@hushh/mcp@beta"],
            env: {
              CONSENT_API_URL: "https://<consent-api-origin>",
              HUSHH_DEVELOPER_TOKEN: "<developer-token>",
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function printCodexToml() {
  console.log('[mcp_servers.hushh_consent]');
  console.log('command = "npx"');
  console.log('args = ["-y", "@hushh/mcp@beta"]');
  console.log("enabled = true");
  console.log('[mcp_servers.hushh_consent.env]');
  console.log('CONSENT_API_URL = "https://<consent-api-origin>"');
  console.log('HUSHH_DEVELOPER_TOKEN = "<developer-token>"');
}

function printRemoteConfig() {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "hushh-consent-remote": {
            url: "https://<consent-api-origin>/mcp/?token=<developer-token>",
          },
        },
      },
      null,
      2,
    ),
  );
}

function fatal(message) {
  process.stderr.write(`[hushh-mcp] ${message}\n`);
  process.exit(1);
}

function resolveRuntimeDir() {
  const override = process.env.HUSHH_MCP_RUNTIME_DIR;
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(path.join(resolved, "mcp_server.py"))) {
      fatal(`HUSHH_MCP_RUNTIME_DIR does not contain mcp_server.py: ${resolved}`);
    }
    return resolved;
  }

  const vendored = path.join(packageDir, "vendor", "consent-protocol");
  if (fs.existsSync(path.join(vendored, "mcp_server.py"))) {
    return vendored;
  }

  const repoFallback = path.resolve(packageDir, "..", "..", "consent-protocol");
  if (fs.existsSync(path.join(repoFallback, "mcp_server.py"))) {
    return repoFallback;
  }

  fatal(
    "Could not find a consent-protocol runtime. Run `npm pack` from this package or set HUSHH_MCP_RUNTIME_DIR.",
  );
}

function runChecked(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: ["ignore", process.stderr, process.stderr],
    ...options,
  });

  if (result.error) {
    return { ok: false, error: result.error };
  }

  return { ok: result.status === 0, status: result.status };
}

function findBasePython() {
  const candidates = [];

  if (process.env.HUSHH_MCP_PYTHON) {
    candidates.push({ command: process.env.HUSHH_MCP_PYTHON, args: [] });
  }

  candidates.push({ command: "python3", args: [] });
  candidates.push({ command: "python", args: [] });

  if (isWindows) {
    candidates.push({ command: "py", args: ["-3"] });
  }

  for (const candidate of candidates) {
    const probe = runChecked(candidate.command, [...candidate.args, "--version"]);
    if (probe.ok) {
      return candidate;
    }
  }

  fatal(
    "Python 3 is required. Set HUSHH_MCP_PYTHON or install python3/python before running hushh-mcp.",
  );
}

function getCacheRoot() {
  if (process.env.HUSHH_MCP_CACHE_DIR) {
    return path.resolve(process.env.HUSHH_MCP_CACHE_DIR);
  }

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) {
    return path.join(xdg, "hushh-mcp");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "hushh-mcp");
  }

  return path.join(os.homedir(), ".cache", "hushh-mcp");
}

function readFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function runtimeHash(runtimeDir) {
  const hash = crypto.createHash("sha256");
  hash.update(packageVersion);
  hash.update(readFileIfPresent(path.join(runtimeDir, "requirements.txt")));
  hash.update(readFileIfPresent(path.join(runtimeDir, "mcp_server.py")));
  return hash.digest("hex");
}

function venvPythonPath(venvDir) {
  return isWindows
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function ensureBootstrap(runtimeDir) {
  if (process.env.HUSHH_MCP_SKIP_BOOTSTRAP === "1") {
    return findBasePython();
  }

  const cacheRoot = getCacheRoot();
  const installRoot = path.join(cacheRoot, `runtime-${packageVersion}`);
  const venvDir = path.join(installRoot, "venv");
  const stampPath = path.join(installRoot, "install-stamp.json");
  const desiredHash = runtimeHash(runtimeDir);
  const pythonExec = venvPythonPath(venvDir);

  if (fs.existsSync(stampPath) && fs.existsSync(pythonExec)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      if (stamp.runtimeHash === desiredHash) {
        return { command: pythonExec, args: [] };
      }
    } catch (error) {
      process.stderr.write(
        `[hushh-mcp] ignoring invalid install stamp at ${stampPath}: ${error.message}\n`,
      );
    }
  }

  fs.mkdirSync(installRoot, { recursive: true });

  const basePython = findBasePython();
  if (!fs.existsSync(pythonExec)) {
    process.stderr.write(`[hushh-mcp] creating Python runtime in ${venvDir}\n`);
    const createVenv = runChecked(basePython.command, [
      ...basePython.args,
      "-m",
      "venv",
      venvDir,
    ]);
    if (!createVenv.ok) {
      fatal("Failed to create Python virtual environment for hushh-mcp.");
    }
  }

  const requirementsPath = path.join(runtimeDir, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    fatal(`requirements.txt not found in runtime: ${requirementsPath}`);
  }

  process.stderr.write(
    `[hushh-mcp] installing Python dependencies from ${requirementsPath}\n`,
  );
  const installDeps = runChecked(pythonExec, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    requirementsPath,
  ]);
  if (!installDeps.ok) {
    fatal("Failed to install Python dependencies for hushh-mcp.");
  }

  fs.writeFileSync(
    stampPath,
    JSON.stringify(
      {
        packageVersion,
        runtimeHash: desiredHash,
      },
      null,
      2,
    ),
  );

  return { command: pythonExec, args: [] };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(filePath) {
  const env = {};
  if (!filePath || !fs.existsSync(filePath)) {
    return env;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    env[key] = unquote(value);
  }

  return env;
}

function composePythonPath(runtimeDir) {
  const parts = [runtimeDir];
  if (process.env.PYTHONPATH) {
    parts.push(process.env.PYTHONPATH);
  }
  return parts.join(path.delimiter);
}

function buildEnv(runtimeDir) {
  const envFile =
    process.env.HUSHH_MCP_ENV_FILE || path.join(runtimeDir, ".env");
  const merged = {
    ...parseEnvFile(envFile),
    ...process.env,
  };

  merged.PYTHONPATH = composePythonPath(runtimeDir);
  merged.PYTHONUNBUFFERED = merged.PYTHONUNBUFFERED || "1";

  if (process.env.HUSHH_MCP_ENV_FILE) {
    merged.HUSHH_MCP_ENV_FILE = process.env.HUSHH_MCP_ENV_FILE;
  }

  return merged;
}

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

if (args.includes("--print-config")) {
  printConfig();
  process.exit(0);
}

if (args.includes("--print-codex-toml")) {
  printCodexToml();
  process.exit(0);
}

if (args.includes("--print-remote-config")) {
  printRemoteConfig();
  process.exit(0);
}

const runtimeDir = resolveRuntimeDir();
const python = ensureBootstrap(runtimeDir);
const serverPath = path.join(runtimeDir, "mcp_server.py");
const childEnv = buildEnv(runtimeDir);

const child = spawn(python.command, [...python.args, serverPath], {
  cwd: runtimeDir,
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  fatal(`Failed to launch Python MCP server: ${error.message}`);
});
