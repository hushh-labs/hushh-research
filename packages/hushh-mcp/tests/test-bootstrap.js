#!/usr/bin/env node

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");


const {
  unquote,
  parseEnvFile,
  runtimeHash,
  venvPythonPath,
  composePythonPath,
  findBasePython,
  MIN_PYTHON_MAJOR,
  MIN_PYTHON_MINOR,
} = require("../bin/hushh-mcp.js");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hushh-mcp-test-"));
}

function removeTmpDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


describe("unquote", () => {
  it("removes surrounding double-quotes", () => {
    assert.equal(unquote('"hello"'), "hello");
  });

  it("removes surrounding single-quotes", () => {
    assert.equal(unquote("'world'"), "world");
  });

  it("leaves unquoted strings unchanged", () => {
    assert.equal(unquote("plain"), "plain");
  });

  it("leaves empty string unchanged", () => {
    assert.equal(unquote(""), "");
  });

  it("does not strip mismatched quotes", () => {
    assert.equal(unquote("\"mixed'"), "\"mixed'");
  });

  it("does not strip a single quote character", () => {
    assert.equal(unquote('"'), '"');
  });

  it("preserves inner quotes when outer are also quoted", () => {
    assert.equal(unquote('"val"ue"'), 'val"ue');
  });
});


describe("parseEnvFile", () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpDir(); });
  after(() => { removeTmpDir(tmpDir); });

  it("returns empty object for a missing file", () => {
    const result = parseEnvFile(path.join(tmpDir, "nonexistent.env"));
    assert.deepEqual(result, {});
  });

  it("returns empty object when filePath is null", () => {
    assert.deepEqual(parseEnvFile(null), {});
  });

  it("returns empty object when filePath is undefined", () => {
    assert.deepEqual(parseEnvFile(undefined), {});
  });

  it("parses unquoted key=value pairs", () => {
    const envPath = path.join(tmpDir, "basic.env");
    fs.writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
    assert.deepEqual(parseEnvFile(envPath), { FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding double-quotes from values", () => {
    const envPath = path.join(tmpDir, "quoted.env");
    fs.writeFileSync(envPath, 'TOKEN="abc123"\n');
    assert.deepEqual(parseEnvFile(envPath), { TOKEN: "abc123" });
  });

  it("strips surrounding single-quotes from values", () => {
    const envPath = path.join(tmpDir, "single.env");
    fs.writeFileSync(envPath, "SECRET='mysecret'\n");
    assert.deepEqual(parseEnvFile(envPath), { SECRET: "mysecret" });
  });

  it("ignores lines starting with #", () => {
    const envPath = path.join(tmpDir, "comments.env");
    fs.writeFileSync(envPath, "# This is a comment\nKEY=value\n");
    assert.deepEqual(parseEnvFile(envPath), { KEY: "value" });
  });

  it("ignores blank lines", () => {
    const envPath = path.join(tmpDir, "blanks.env");
    fs.writeFileSync(envPath, "\n\nKEY=value\n\n");
    assert.deepEqual(parseEnvFile(envPath), { KEY: "value" });
  });

  it("ignores lines with no = separator", () => {
    const envPath = path.join(tmpDir, "nosep.env");
    fs.writeFileSync(envPath, "INVALID\nKEY=value\n");
    assert.deepEqual(parseEnvFile(envPath), { KEY: "value" });
  });

  it("ignores lines where = is the first character (empty key)", () => {
    const envPath = path.join(tmpDir, "emptykey.env");
    fs.writeFileSync(envPath, "=value\nKEY=ok\n");
    assert.deepEqual(parseEnvFile(envPath), { KEY: "ok" });
  });

  it("handles Windows-style CRLF line endings", () => {
    const envPath = path.join(tmpDir, "crlf.env");
    fs.writeFileSync(envPath, "FOO=bar\r\nBAZ=qux\r\n");
    assert.deepEqual(parseEnvFile(envPath), { FOO: "bar", BAZ: "qux" });
  });

  it("value may contain = characters", () => {
    const envPath = path.join(tmpDir, "equals.env");
    fs.writeFileSync(envPath, "TOKEN=abc==\n");
    assert.deepEqual(parseEnvFile(envPath), { TOKEN: "abc==" });
  });
});


describe("venvPythonPath", () => {
  it("returns a non-empty string", () => {
    const result = venvPythonPath("/some/venv");
    assert.ok(typeof result === "string" && result.length > 0);
  });

  it("includes the provided venvDir as a prefix", () => {
    const result = venvPythonPath("/some/venv");
    assert.ok(result.startsWith("/some/venv") || result.startsWith("\\some\\venv"));
  });

  it("ends with 'python' or 'python.exe'", () => {
    const result = venvPythonPath("/some/venv");
    assert.ok(result.endsWith("python") || result.endsWith("python.exe"),
      `Expected path to end with 'python' or 'python.exe', got: ${result}`);
  });

  it("includes 'Scripts' on Windows or 'bin' on POSIX (platform-consistent)", () => {
    const result = venvPythonPath("/some/venv");
    const isWin = process.platform === "win32";
    if (isWin) {
      assert.ok(result.includes("Scripts"),
        `Expected 'Scripts' in Windows path, got: ${result}`);
    } else {
      assert.ok(result.includes("bin"),
        `Expected 'bin' in POSIX path, got: ${result}`);
    }
  });
});


describe("runtimeHash", () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpDir(); });
  after(() => { removeTmpDir(tmpDir); });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = runtimeHash(tmpDir);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const h1 = runtimeHash(tmpDir);
    const h2 = runtimeHash(tmpDir);
    assert.equal(h1, h2);
  });

  it("changes when requirements.txt changes", () => {
    const reqPath = path.join(tmpDir, "requirements.txt");
    fs.writeFileSync(reqPath, "fastapi==0.100.0\n");
    const h1 = runtimeHash(tmpDir);

    fs.writeFileSync(reqPath, "fastapi==0.136.0\n");
    const h2 = runtimeHash(tmpDir);

    assert.notEqual(h1, h2, "Hash must change when requirements.txt changes");
  });

  it("changes when mcp_server.py changes", () => {
    const serverPath = path.join(tmpDir, "mcp_server.py");
    fs.writeFileSync(serverPath, "# version 1\n");
    const h1 = runtimeHash(tmpDir);

    fs.writeFileSync(serverPath, "# version 2\n");
    const h2 = runtimeHash(tmpDir);

    assert.notEqual(h1, h2, "Hash must change when mcp_server.py changes");
  });

  it("is stable even when neither file exists (empty-file baseline)", () => {
    // Removing both optional files should still produce a stable hash
    const emptyDir = makeTmpDir();
    try {
      const h1 = runtimeHash(emptyDir);
      const h2 = runtimeHash(emptyDir);
      assert.equal(h1, h2);
    } finally {
      removeTmpDir(emptyDir);
    }
  });
});


describe("composePythonPath", () => {
  const originalPythonPath = process.env.PYTHONPATH;

  after(() => {
    
    if (originalPythonPath === undefined) {
      delete process.env.PYTHONPATH;
    } else {
      process.env.PYTHONPATH = originalPythonPath;
    }
  });

  it("starts with the runtimeDir", () => {
    delete process.env.PYTHONPATH;
    const result = composePythonPath("/runtime/dir");
    assert.ok(result.startsWith("/runtime/dir"));
  });

  it("appends existing PYTHONPATH when set", () => {
    process.env.PYTHONPATH = "/extra/path";
    const result = composePythonPath("/runtime/dir");
    assert.ok(result.includes("/extra/path"),
      `Expected '/extra/path' in composed path, got: ${result}`);
  });

  it("does not add a separator when PYTHONPATH is absent", () => {
    delete process.env.PYTHONPATH;
    const result = composePythonPath("/runtime/dir");
    // Should be exactly the runtimeDir with no trailing delimiter
    const delimiter = path.delimiter; // ':' on POSIX, ';' on Windows
    assert.ok(!result.endsWith(delimiter),
      `Path should not end with delimiter '${delimiter}', got: ${result}`);
  });
});


describe("findBasePython integration", () => {
  it(`finds a Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} interpreter`, () => {
    const result = findBasePython();
    assert.ok(typeof result === "object", "Should return a candidate object");
    assert.ok(typeof result.command === "string" && result.command.length > 0,
      "Should have a non-empty command string");
    assert.ok(Array.isArray(result.args),
      "Should have an args array");
  });

  it("returned interpreter actually runs without error", () => {
    const { spawnSync } = require("node:child_process");
    const { command, args } = findBasePython();
    const probe = spawnSync(command, [...args, "--version"], { encoding: "utf8" });
    assert.equal(probe.status, 0, `Python --version exited with status ${probe.status}`);
  });

  it(`returned interpreter reports version >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}`, () => {
    const { spawnSync } = require("node:child_process");
    const { command, args } = findBasePython();
    const probe = spawnSync(
      command,
      [
        ...args,
        "-c",
        "import sys; print(sys.version_info.major, sys.version_info.minor)",
      ],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0);
    const [major, minor] = probe.stdout.trim().split(" ").map(Number);
    assert.ok(
      major > MIN_PYTHON_MAJOR ||
        (major === MIN_PYTHON_MAJOR && minor >= MIN_PYTHON_MINOR),
      `Expected Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}, got ${major}.${minor}`,
    );
  });
});


describe("MIN_PYTHON_VERSION constants", () => {
  it("MIN_PYTHON_MAJOR is a positive integer", () => {
    assert.ok(Number.isInteger(MIN_PYTHON_MAJOR) && MIN_PYTHON_MAJOR > 0);
  });

  it("MIN_PYTHON_MINOR is a non-negative integer", () => {
    assert.ok(Number.isInteger(MIN_PYTHON_MINOR) && MIN_PYTHON_MINOR >= 0);
  });

  it("version floor is at least 3.10", () => {
    const isAtLeast310 =
      MIN_PYTHON_MAJOR > 3 ||
      (MIN_PYTHON_MAJOR === 3 && MIN_PYTHON_MINOR >= 10);
    assert.ok(isAtLeast310,
      `MIN_PYTHON version (${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}) is below the 3.10 floor required by consent-protocol deps`);
  });
});