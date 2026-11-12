#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CONFIG_RESOURCES, workspaceRoot } = require("./workspace-setup");
const { RECEIPT_PATH, digest, gitBlobDigest, loadSourceClassifier } = require("./shareable-source-classification.cjs");

const repoRoot = workspaceRoot;
const tmpRoot = CONFIG_RESOURCES.tmpDirectory;
const ignoredDirs = new Set(["node_modules", ".git", ".next", "DerivedData"]);
const repoLocalLinkRoots = ["docs", "consent-protocol", "hushh-webapp", "packages", ".codex"];
const repoishPrefixes = [
  "./",
  "../",
  ...repoLocalLinkRoots.map((root) => `${normalize(root)}/`),
];
const homeDir = normalize(os.homedir());
const escapedHomeDir = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const localAbsolutePathPatterns = [
  /\b[A-Za-z]:[\\/][^\s)'"<>]+/,
  /(^|[\s('"`])\/(?:home|Users|var|tmp|private|Volumes)\/[^\s)'"<>]+/,
  ...(escapedHomeDir ? [new RegExp(`${escapedHomeDir}[^\\s)'"<>]*`)] : []),
];

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function hasFileUri(value) {
  return /\bfile:\/\//i.test(value);
}

function looksAbsoluteLocalPath(value) {
  const cleaned = normalize(value.trim());
  if (!cleaned) return false;
  if (homeDir && cleaned.startsWith(homeDir)) return true;
  return path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(value);
}

function containsAbsoluteLocalPath(value) {
  return localAbsolutePathPatterns.some((pattern) => pattern.test(value));
}

function walkShareableFiles(root = repoRoot, artifactRoot = tmpRoot) {
  if (!fs.existsSync(artifactRoot)) return [];
  const out = [];

  const visit = (dir) => {
    if (dir !== artifactRoot && fs.existsSync(path.join(dir, ".git"))) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const full = path.resolve(root, path.relative(root, path.join(dir, entry.name)));
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".md") || entry.name.endsWith(".html")) {
        out.push(normalize(path.relative(root, full)));
      }
    }
  };

  visit(artifactRoot);
  return out;
}

function tokenLooksRepoLocal(token) {
  if (!token) return false;
  const cleaned = token.trim();
  if (!cleaned) return false;
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.startsWith("mailto:")) return false;
  if (cleaned.startsWith("#")) return false;
  if (hasFileUri(cleaned) || looksAbsoluteLocalPath(cleaned)) return true;
  return repoishPrefixes.some((prefix) => cleaned.startsWith(prefix));
}

function collectFailures(root = repoRoot, artifactRoot = tmpRoot) {
  const sourceIsPreserved = loadSourceClassifier(root);
  const files = walkShareableFiles(root, artifactRoot);
  const failures = [];

  for (const relFile of files) {
    const bytes = fs.readFileSync(path.join(root, relFile));
    if (sourceIsPreserved(relFile, bytes)) continue;
    const src = bytes.toString("utf8");

    if (hasFileUri(src)) {
      failures.push(`${relFile}: contains file:// link`);
    }
    if (containsAbsoluteLocalPath(src)) {
      failures.push(`${relFile}: contains local absolute path`);
    }

    for (const match of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const token = (match[1] || "").trim();
      if (tokenLooksRepoLocal(token)) {
        failures.push(`${relFile}: non-shareable markdown link -> ${token}`);
      }
    }

    for (const match of src.matchAll(/\bhref=["']([^"']+)["']/g)) {
      const token = (match[1] || "").trim();
      if (tokenLooksRepoLocal(token)) {
        failures.push(`${relFile}: non-shareable href -> ${token}`);
      }
    }
  }

  return failures;
}

function fixtureReceipt(root) {
  const sourcePath = "tmp/captured-alpha/docs/source.md";
  const sourceBytes = Buffer.from("[internal source](./reference.md)\n");
  fs.mkdirSync(path.dirname(path.join(root, sourcePath)), { recursive: true });
  fs.writeFileSync(path.join(root, sourcePath), sourceBytes);
  const manifestPath = "tmp/preservation.json";
  const manifest = { base: "a".repeat(40), purpose: "Preserved source bytes", leaves: [
    { path: "docs/source.md", sha256: digest(sourceBytes) },
  ] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, manifestPath), manifestBytes);
  return { version: 1, snapshots: [{
    root: "tmp/captured-alpha",
    provenance: { kind: "preservation_manifest", base: manifest.base,
      manifest: { path: manifestPath, sha256: digest(manifestBytes) } },
    files: [{ path: "docs/source.md", sha256: digest(sourceBytes), proof: { kind: "preserved" } }],
  }] };
}

function testExportClassification(root, receipt, assert) {
  const writeReceipt = () => fs.writeFileSync(path.join(root, RECEIPT_PATH), JSON.stringify(receipt));
  assert(collectFailures(root, path.join(root, "tmp")).length > 0, "No receipt must preserve the gate");
  writeReceipt();
  assert.deepStrictEqual(collectFailures(root, path.join(root, "tmp")), []);
  fs.writeFileSync(path.join(root, "tmp/captured-alpha/new-export.html"), '<a href="docs/internal.md">Export</a>');
  let failures = collectFailures(root, path.join(root, "tmp"));
  assert(failures.some((failure) => failure.includes("new-export.html")), "Unlisted exports stay checked");
  fs.writeFileSync(path.join(root, "tmp/export.md"), "[local](file:///tmp/private.md)\n[repo](../docs/a.md)");
  fs.writeFileSync(path.join(root, "tmp/export.html"), '<a href="./docs/a.md">Local</a> /Users/example/private.md');
  failures = collectFailures(root, path.join(root, "tmp"));
  assert(failures.some((failure) => failure.includes("export.md: contains file://")));
  assert(failures.some((failure) => failure.includes("export.md: non-shareable markdown link")));
  assert(failures.some((failure) => failure.includes("export.html: non-shareable href")));
  assert(failures.some((failure) => failure.includes("export.html: contains local absolute path")));
  fs.appendFileSync(path.join(root, "tmp/captured-alpha/docs/source.md"), "[changed](./new.md)\n");
  failures = collectFailures(root, path.join(root, "tmp"));
  assert(failures.some((failure) => failure.includes("source.md")), "Changed source bytes stay checked");
}

function testInvalidProvenance(root, receipt, assert) {
  const rejects = (candidate) => {
    fs.writeFileSync(path.join(root, RECEIPT_PATH), JSON.stringify(candidate));
    assert.throws(() => collectFailures(root, path.join(root, "tmp")));
  };
  rejects({ ...receipt, version: 2 });
  rejects({ version: 1, snapshots: "malformed" });
  fs.writeFileSync(path.join(root, RECEIPT_PATH), "{broken JSON");
  assert.throws(() => collectFailures(root, path.join(root, "tmp")));
  for (const unsafe of ["../export.md", "/tmp/export.md", "docs/../../export.md", "C:\\export.md"]) {
    const candidate = structuredClone(receipt);
    candidate.snapshots[0].files[0].path = unsafe;
    rejects(candidate);
  }
  const unknown = structuredClone(receipt);
  unknown.snapshots[0].provenance.kind = "unverified_source";
  rejects(unknown);
  const stale = structuredClone(receipt);
  stale.snapshots[0].provenance.manifest.sha256 = "0".repeat(64);
  rejects(stale);
  const unsafeRecord = structuredClone(receipt);
  unsafeRecord.snapshots[0].provenance.manifest.path = "tmp/../outside.json";
  rejects(unsafeRecord);
  const outside = structuredClone(receipt);
  outside.snapshots[0].root = "scripts";
  rejects(outside);
  fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), path.join(root, "tmp/escaped"), "dir");
  const escaped = structuredClone(receipt);
  escaped.snapshots[0].root = "tmp/escaped";
  rejects(escaped);
  fs.renameSync(path.join(root, "tmp/captured-alpha/docs/source.md"), path.join(root, "outside/source.md"));
  fs.symlinkSync(path.join(root, "outside/source.md"), path.join(root, "tmp/captured-alpha/docs/source.md"));
  rejects(receipt);
}

function testPullRequestBlobProof(root, assert) {
  const relative = "tmp/captured-alpha/docs/source.md";
  const bytes = fs.readFileSync(path.join(root, relative));
  const record = (name, value) => {
    const content = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(path.join(root, name), content);
    return { path: name, sha256: digest(content) };
  };
  const files = [{ filename: "docs/source.md", status: "modified", sha: gitBlobDigest(bytes) }];
  const provenance = { kind: "pull_request_files", head: "b".repeat(40),
    pullRequest: record("tmp/pr.json", { head: { sha: "b".repeat(40) } }),
    filesRecord: record("tmp/pr-files.json", files) };
  const receipt = { version: 1, snapshots: [{ root: "tmp/captured-alpha", provenance,
    files: [{ path: "docs/source.md", sha256: digest(bytes),
      proof: { kind: "git_blob", sha1: files[0].sha } }] }] };
  const save = () => fs.writeFileSync(path.join(root, RECEIPT_PATH), JSON.stringify(receipt));
  save();
  assert(loadSourceClassifier(root)(relative, bytes), "Exact PR blob bytes can prove source");
  files[0].sha = "c".repeat(40);
  provenance.filesRecord = record("tmp/pr-files.json", files);
  receipt.snapshots[0].files[0].proof.sha1 = files[0].sha;
  save();
  assert(!loadSourceClassifier(root)(relative, bytes), "A receipt hash cannot substitute for PR blob proof");
  assert(collectFailures(root, path.join(root, "tmp")).some((failure) => failure.includes("source.md")));
}

function selfTest() {
  const assert = require("node:assert/strict");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shareable-links-self-test-"));
  try {
    const receipt = fixtureReceipt(root);
    testExportClassification(root, receipt, assert);
    testPullRequestBlobProof(root, assert);
    testInvalidProvenance(root, receipt, assert);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("OK: shareable links self-test passed");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const failures = collectFailures();
  if (failures.length > 0) {
    console.error("ERROR: shareable links check failed");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("OK: shareable links check passed");
}

if (require.main === module) {
  try { main(); } catch {
    console.error(process.argv.includes("--self-test") ? "ERROR: shareable links self-test failed" :
      "ERROR: shareable links check failed (invalid source-snapshot receipt or provenance)");
    process.exitCode = 1;
  }
}

module.exports = { collectFailures };
