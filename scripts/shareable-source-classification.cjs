// SPDX-License-Identifier: Apache-2.0
// Owner: platform (docs-governance). Exact source provenance for the artifact gate.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RECEIPT_PATH = "tmp/shareable-source-snapshots.v1.json";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^[a-f0-9]{40}$/;

function invariant(condition) {
  if (!condition) throw new Error("invalid source-snapshot receipt or provenance");
}

function objectWithKeys(value, keys) {
  invariant(value && typeof value === "object" && !Array.isArray(value));
  invariant(Object.keys(value).sort().join("|") === [...keys].sort().join("|"));
}

function relativePath(value) {
  invariant(typeof value === "string" && value.length > 0);
  invariant(!value.includes("\\") && !value.includes(":") && !value.includes("\0"));
  invariant(!path.posix.isAbsolute(value) && path.posix.normalize(value) === value);
  invariant(value.split("/").every((part) => part && part !== "." && part !== ".."));
  return value;
}

function safePath(root, relative, directory = false) {
  relativePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    invariant(!fs.lstatSync(current).isSymbolicLink());
  }
  const stat = fs.statSync(current);
  invariant(directory ? stat.isDirectory() : stat.isFile());
  invariant(fs.realpathSync(current).startsWith(`${fs.realpathSync(root)}${path.sep}`));
  return current;
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function gitBlobDigest(bytes) {
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function readRecord(root, descriptor) {
  objectWithKeys(descriptor, ["path", "sha256"]);
  invariant(relativePath(descriptor.path).startsWith("tmp/") && SHA256.test(descriptor.sha256));
  const bytes = fs.readFileSync(safePath(root, descriptor.path));
  invariant(digest(bytes) === descriptor.sha256);
  return JSON.parse(bytes.toString("utf8"));
}

function preservedLeaves(manifest) {
  invariant(manifest && GIT_OID.test(manifest.base) && Array.isArray(manifest.leaves));
  invariant(typeof manifest.purpose === "string" && manifest.purpose.length > 0);
  const leaves = new Map();
  for (const leaf of manifest.leaves) {
    objectWithKeys(leaf, ["path", "sha256"]);
    relativePath(leaf.path);
    invariant(SHA256.test(leaf.sha256) && !leaves.has(leaf.path));
    leaves.set(leaf.path, leaf.sha256);
  }
  return leaves;
}

function gitCatalog(root, ref, cache) {
  invariant(GIT_OID.test(ref));
  if (cache.has(ref)) return cache.get(ref);
  const output = execFileSync("git", ["ls-tree", "-r", "-z", ref], {
    cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const catalog = new Map();
  for (const row of output.split("\0")) {
    if (!row) continue;
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (match && match[1] !== "120000") catalog.set(match[3], match[2]);
  }
  cache.set(ref, catalog);
  return catalog;
}

function preservationProof(root, provenance) {
  objectWithKeys(provenance, ["kind", "manifest", "base"]);
  const manifest = readRecord(root, provenance.manifest);
  const leaves = preservedLeaves(manifest);
  invariant(provenance.base === manifest.base);
  return (file) => {
    objectWithKeys(file.proof, ["kind"]);
    invariant(file.proof.kind === "preserved" && leaves.get(file.path) === file.sha256);
    return () => true;
  };
}

function pullRequestProof(root, provenance) {
  objectWithKeys(provenance, ["kind", "pullRequest", "filesRecord", "head"]);
  const pr = readRecord(root, provenance.pullRequest);
  const files = readRecord(root, provenance.filesRecord);
  invariant(GIT_OID.test(provenance.head) && pr?.head?.sha === provenance.head && Array.isArray(files));
  const blobs = new Map();
  for (const file of files) {
    relativePath(file.filename);
    invariant(GIT_OID.test(file.sha) && !blobs.has(file.filename));
    if (file.status !== "removed") blobs.set(file.filename, file.sha);
  }
  return (file) => {
    objectWithKeys(file.proof, ["kind", "sha1"]);
    invariant(file.proof.kind === "git_blob" && blobs.get(file.path) === file.proof.sha1);
    return (bytes) => gitBlobDigest(bytes) === file.proof.sha1;
  };
}

function reconciledChanges(review, leaves) {
  invariant(Array.isArray(review.root_wip_bytes_changed));
  const changes = new Map();
  for (const change of review.root_wip_bytes_changed) {
    relativePath(change.original_path);
    relativePath(change.reconciled_path);
    invariant(SHA256.test(change.original_sha256) && SHA256.test(change.reconciled_sha256));
    invariant(leaves.get(change.original_path) === change.original_sha256);
    invariant(!changes.has(change.reconciled_path));
    changes.set(change.reconciled_path, change.reconciled_sha256);
  }
  return changes;
}

function baseBlobProof(root, refs, cache, file) {
  objectWithKeys(file.proof, ["kind", "ref", "sha1"]);
  invariant(file.proof.kind === "base_git_blob" && refs.includes(file.proof.ref));
  invariant(gitCatalog(root, file.proof.ref, cache).get(file.path) === file.proof.sha1);
  return (bytes) => gitBlobDigest(bytes) === file.proof.sha1;
}

function reconciledFilesProof(root, refs, leaves, changes, cache) {
  return (file) => {
    if (file.proof.kind === "base_git_blob") {
      return baseBlobProof(root, refs, cache, file);
    }
    objectWithKeys(file.proof, ["kind"]);
    const expected = file.proof.kind === "preserved" ? leaves.get(file.path) : changes.get(file.path);
    invariant(["preserved", "reconciled"].includes(file.proof.kind) && expected === file.sha256);
    return () => true;
  };
}

function reconciledProof(root, snapshotRoot, provenance, cache) {
  objectWithKeys(provenance, ["kind", "manifest", "review", "baseRefs"]);
  const leaves = preservedLeaves(readRecord(root, provenance.manifest));
  const review = readRecord(root, provenance.review);
  invariant(typeof review.source_snapshot === "string");
  invariant(path.resolve(root, review.source_snapshot) === path.resolve(root, snapshotRoot));
  invariant(Array.isArray(provenance.baseRefs) && provenance.baseRefs.length === 2);
  invariant(provenance.baseRefs[0] === review.root_head && provenance.baseRefs[1] === review.candidate_base);
  return reconciledFilesProof(root, provenance.baseRefs, leaves, reconciledChanges(review, leaves), cache);
}

function reviewedRefs(root, provenance) {
  const review = readRecord(root, provenance.review);
  const allowed = new Set(["candidate_source_revision", "base", "input_base", "root_head", "candidate_head_at_end"]);
  invariant(Array.isArray(provenance.revisionFields) && provenance.revisionFields.length > 0);
  invariant(new Set(provenance.revisionFields).size === provenance.revisionFields.length);
  return provenance.revisionFields.map((field) => {
    invariant(allowed.has(field) && GIT_OID.test(review[field]));
    return review[field];
  });
}

function gitSourceCopyProof(root, provenance, cache) {
  objectWithKeys(provenance, ["kind", "review", "revisionFields"]);
  const refs = reviewedRefs(root, provenance);
  return (file) => baseBlobProof(root, refs, cache, file);
}

function reconciledSourceCopyProof(root, provenance, cache) {
  objectWithKeys(provenance, ["kind", "review", "revisionFields", "manifest", "reconciliationReview"]);
  const refs = reviewedRefs(root, provenance);
  const leaves = preservedLeaves(readRecord(root, provenance.manifest));
  const review = readRecord(root, provenance.reconciliationReview);
  invariant(typeof review.source_snapshot === "string");
  const originalRoot = path.relative(root, path.resolve(root, review.source_snapshot)).replace(/\\/g, "/");
  invariant(relativePath(originalRoot).startsWith("tmp/"));
  safePath(root, originalRoot, true);
  return reconciledFilesProof(root, refs, leaves, reconciledChanges(review, leaves), cache);
}

function snapshotProof(root, snapshot, cache) {
  invariant(snapshot.provenance && typeof snapshot.provenance.kind === "string");
  switch (snapshot.provenance.kind) {
    case "preservation_manifest": return preservationProof(root, snapshot.provenance);
    case "pull_request_files": return pullRequestProof(root, snapshot.provenance);
    case "reconciled_source": return reconciledProof(root, snapshot.root, snapshot.provenance, cache);
    case "git_source_copy": return gitSourceCopyProof(root, snapshot.provenance, cache);
    case "reconciled_source_copy": return reconciledSourceCopyProof(root, snapshot.provenance, cache);
    default: invariant(false);
  }
}

function loadSourceClassifier(root, receiptRelative = RECEIPT_PATH) {
  relativePath(receiptRelative);
  invariant(receiptRelative.startsWith("tmp/"));
  const receiptPath = path.join(root, receiptRelative);
  if (!fs.existsSync(receiptPath)) return () => false;
  const receipt = JSON.parse(fs.readFileSync(safePath(root, receiptRelative), "utf8"));
  objectWithKeys(receipt, ["version", "snapshots"]);
  invariant(receipt.version === 1 && Array.isArray(receipt.snapshots));
  const entries = new Map();
  const roots = new Set();
  const cache = new Map();
  for (const snapshot of receipt.snapshots) {
    objectWithKeys(snapshot, ["root", "provenance", "files"]);
    invariant(relativePath(snapshot.root).startsWith("tmp/") && !roots.has(snapshot.root));
    invariant(!receiptRelative.startsWith(`${snapshot.root}/`));
    safePath(root, snapshot.root, true);
    roots.add(snapshot.root);
    invariant(Array.isArray(snapshot.files));
    const proofFor = snapshotProof(root, snapshot, cache);
    for (const file of snapshot.files) {
      objectWithKeys(file, ["path", "sha256", "proof"]);
      relativePath(file.path);
      invariant(/\.(md|html)$/.test(file.path) && SHA256.test(file.sha256));
      const relative = `${snapshot.root}/${file.path}`;
      invariant(!entries.has(relative));
      safePath(root, relative);
      entries.set(relative, { sha256: file.sha256, provesBytes: proofFor(file) });
    }
  }
  return (relative, bytes) => {
    const entry = entries.get(relative);
    if (!entry) return false;
    // Recheck path admission at use time; no directory or changed-byte exemption.
    safePath(root, relative);
    return digest(bytes) === entry.sha256 && entry.provesBytes(bytes);
  };
}

module.exports = { RECEIPT_PATH, digest, gitBlobDigest, loadSourceClassifier };
