#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-mcp-packed-"));
const installDir = path.join(tempRoot, "install");
fs.mkdirSync(installDir, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function testPythonPath() {
  const executable = process.platform === "win32" ? "python.exe" : "python";
  const candidate = path.resolve(
    packageDir,
    "..",
    "..",
    "consent-protocol",
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    executable,
  );
  return fs.existsSync(candidate) ? candidate : "";
}

function nextJsonLine(lines, { child, stderr, label, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      lines.removeListener("line", onLine);
      child.kill("SIGTERM");
      const exit = child.exitCode === null ? "running" : String(child.exitCode);
      reject(
        new Error(
          `Packed MCP ${label} response timed out (exit=${exit}; stderr=${stderr().slice(0, 500)})`,
        ),
      );
    }, timeoutMs);
    const onLine = (line) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    lines.once("line", onLine);
  });
}

try {
  const packageSpec = String(process.env.HUSHH_MCP_PACKAGE_SPEC || "").trim();
  let installTarget = packageSpec;
  if (!installTarget) {
    const packResult = JSON.parse(
      run("npm", ["pack", "--json", "--pack-destination", tempRoot], packageDir),
    );
    installTarget = path.join(tempRoot, packResult[0].filename);
  }
  run("npm", ["init", "-y"], installDir);
  run(
    "npm",
    ["install", "--ignore-scripts", "--cache", path.join(tempRoot, "npm-cache"), installTarget],
    installDir,
  );

  const executable = path.join(
    installDir,
    "node_modules",
    "@hushh",
    "mcp",
    "bin",
    "hushh-mcp.js",
  );
  const child = spawn(process.execPath, [executable], {
    cwd: installDir,
    env: {
      ...process.env,
      TESTING: "true",
      APP_SIGNING_KEY: "test_secret_key_for_packed_runtime_32chars",
      VAULT_DATA_KEY: "0".repeat(64),
      HUSHH_MCP_SKIP_BOOTSTRAP: "1",
      HUSHH_MCP_CACHE_DIR: path.join(tempRoot, "runtime-cache"),
      HUSHH_MCP_PYTHON: process.env.HUSHH_MCP_PYTHON || testPythonPath(),
      HUSHH_DEVELOPER_TOKEN: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "packed-runtime-check", version: "1.0" },
      },
    })}\n`,
  );
  const responseOptions = (label) => ({ child, stderr: () => stderr, label });
  const initialized = await nextJsonLine(lines, responseOptions("initialization"));
  if (initialized?.result?.serverInfo?.version !== "0.3.0") {
    throw new Error(`Packed MCP initialization mismatch: ${JSON.stringify(initialized)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  );
  const listed = await nextJsonLine(lines, responseOptions("tool-list"));
  const names = listed?.result?.tools?.map((tool) => tool.name);
  const expected = [
    "search_user_scopes",
    "prepare_campaign_context",
    "request_consent",
    "check_consent_status",
    "get_encrypted_scoped_export",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Packed MCP tool mismatch: ${JSON.stringify(names)} stderr=${stderr.slice(0, 500)}`);
  }
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_user_scopes",
        arguments: { user_identifier: "package-verifier@example.invalid" },
      },
    })}\n`,
  );
  const called = await nextJsonLine(lines, responseOptions("tool-call"));
  if (called?.result?.structuredContent?.error_code !== "AUTHENTICATION_REQUIRED") {
    throw new Error(`Packed MCP tool-call mismatch: ${JSON.stringify(called)}`);
  }
  if (called?.result?.isError !== true) {
    throw new Error(`Packed MCP errors must set isError=true: ${JSON.stringify(called)}`);
  }
  if (JSON.stringify(called).includes("package-verifier@example.invalid")) {
    throw new Error("Packed MCP tool call echoed the supplied identity");
  }
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "check_consent_status",
        arguments: {
          request_ref: "req_0123456789abcdef0123456789ab",
          user_id: "must-not-be-accepted",
        },
      },
    })}\n`,
  );
  const rejected = await nextJsonLine(lines, responseOptions("schema-rejection"));
  if (rejected?.result?.structuredContent?.error_code !== "INVALID_ARGUMENTS") {
    throw new Error(`Packed MCP strict-schema mismatch: ${JSON.stringify(rejected)}`);
  }
  if (rejected?.result?.isError !== true) {
    throw new Error(`Packed schema errors must set isError=true: ${JSON.stringify(rejected)}`);
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  process.stdout.write(
    `${packageSpec ? "Registry" : "Packed"} MCP initialization, public-tool listing, and tool call passed.\n`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
