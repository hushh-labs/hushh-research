// SPDX-License-Identifier: Apache-2.0
/** Read, validate and attest exact-attempt UAT release receipts. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const CHAT_ONLY_WORKFLOW = ".github/workflows/deploy-uat-one-chat.yml";
const FULL_UAT_WORKFLOW = ".github/workflows/deploy-uat.yml";
const UAT_ATTEMPT_TAG_PREFIX = "deployed/uat-attempt";
const UAT_ATTEMPT_TAG_FORMAT = "HUSHH-RELEASE-ATTEMPT-RECEIPT v1";
const UAT_ATTEMPT_RECEIPT_WRITER_NAMES = {
  full: "Persist and attest exact UAT attempt receipt",
  "one-chat": "Persist and attest exact One Chat UAT attempt receipt",
};

export function createUatReleaseReaders(context) {
  const { repository, token, api, git, isAncestor } = context;

  function verifyUatAttemptAttestation(receiptBytes, kind, runId, runAttempt) {
    const directory = mkdtempSync(join(tmpdir(), "hushh-uat-attempt-"));
    const subject = join(directory, "acceptance.json");
    try {
      writeFileSync(subject, receiptBytes, { mode: 0o600, flag: "wx" });
      execFileSync("python3", [
        "scripts/ci/uat_attempt_receipt.py", "verify-attestation",
        "--kind", kind,
        "--environment", "uat",
        "--run-id", String(runId),
        "--attempt", String(runAttempt),
        "--receipt", subject,
      ], { encoding: "utf8", timeout: 50_000, maxBuffer: 128 * 1024 });
    } catch {
      throw new Error(`UAT ${kind} attempt ${runAttempt} receipt provenance verification failed.`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  async function apiBytes(path) {
    if (!token) throw new Error("GITHUB_TOKEN is required to read release evidence.");
    // This is a Node CI script; browser and native app code use ApiService.
    // eslint-disable-next-line no-restricted-syntax
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} -> ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  function zipFile(bytes, expectedName, label = "release artifact") {
    const minimum = Math.max(0, bytes.length - 65_557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
      if (bytes.readUInt32LE(offset) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error(`${label} is not a valid ZIP archive.`);
    const entryCount = bytes.readUInt16LE(endOffset + 10);
    const directorySize = bytes.readUInt32LE(endOffset + 12);
    const directoryOffset = bytes.readUInt32LE(endOffset + 16);
    if (entryCount > 64 || directoryOffset + directorySize > endOffset)
      throw new Error(`${label} has an unsupported ZIP directory.`);

    let cursor = directoryOffset;
    const matches = [];
    for (let index = 0; index < entryCount; index += 1) {
      if (bytes.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error(`${label} has a malformed ZIP entry.`);
      const method = bytes.readUInt16LE(cursor + 10);
      const compressedSize = bytes.readUInt32LE(cursor + 20);
      const uncompressedSize = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      const localOffset = bytes.readUInt32LE(cursor + 42);
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      cursor += 46 + nameLength + extraLength + commentLength;
      if (name !== expectedName && !name.endsWith(`/${expectedName}`)) continue;
      if (compressedSize > 1_000_000 || uncompressedSize > 1_000_000 ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error(`${label} receipt exceeds its bounded artifact contract.`);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!content || content.length !== uncompressedSize)
        throw new Error(`${label} receipt uses an unsupported or damaged ZIP entry.`);
      matches.push(content.toString("utf8"));
    }
    if (matches.length !== 1) throw new Error(`${label} receipt is missing or ambiguous.`);
    return matches[0];
  }

  async function durableUatAttemptReceipt(runId, runAttempt, kind) {
    const tagName = `${UAT_ATTEMPT_TAG_PREFIX}/${runId}-${runAttempt}`;
    let ref;
    try {
      ref = await api(`/git/ref/tags/${tagName}`);
    } catch (error) {
      if (String(error?.message || "").includes("-> 404")) return null;
      throw error;
    }
    if (ref.ref !== `refs/tags/${tagName}` || ref.object?.type !== "tag" ||
      !/^[0-9a-f]{40}$/.test(String(ref.object?.sha)))
      throw new Error(`UAT attempt tag ${runAttempt} has an invalid reference.`);
    const tag = await api(`/git/tags/${ref.object.sha}`);
    if (tag.tag !== tagName || tag.object?.type !== "commit" ||
      !/^[0-9a-f]{40}$/.test(String(tag.object?.sha)))
      throw new Error(`UAT attempt tag ${runAttempt} is not an annotated commit tag.`);
    const fields = {};
    const lines = String(tag.message || "").split(/\r?\n/);
    if (lines.shift() !== UAT_ATTEMPT_TAG_FORMAT)
      throw new Error(`UAT attempt tag ${runAttempt} has an unsupported format.`);
    for (const line of lines) {
      if (!line) continue;
      const separator = line.indexOf(": ");
      if (separator < 1 || fields[line.slice(0, separator)] !== undefined)
        throw new Error(`UAT attempt tag ${runAttempt} has malformed fields.`);
      fields[line.slice(0, separator)] = line.slice(separator + 2);
    }
    const expectedWorkflow = kind === "full" ? FULL_UAT_WORKFLOW : CHAT_ONLY_WORKFLOW;
    const requiredFields = ["kind", "repository", "workflow", "run_id", "run_attempt", "sha",
      "receipt_sha256", "receipt_json_base64"];
    if (requiredFields.some((field) => typeof fields[field] !== "string") ||
      Object.keys(fields).length !== requiredFields.length || fields.kind !== kind ||
      fields.repository !== repository || fields.workflow !== expectedWorkflow ||
      fields.run_id !== String(runId) || fields.run_attempt !== String(runAttempt) ||
      !/^[0-9a-f]{40}$/.test(fields.sha))
      throw new Error(`UAT attempt tag ${runAttempt} identity is mismatched.`);
    const raw = Buffer.from(fields.receipt_json_base64, "base64");
    if (raw.length < 1 || raw.length > 512_000 || raw.toString("base64") !== fields.receipt_json_base64 ||
      createHash("sha256").update(raw).digest("hex") !== fields.receipt_sha256 ||
      tag.object.sha !== fields.sha)
      throw new Error(`UAT attempt tag ${runAttempt} receipt digest or source is invalid.`);
    let receipt;
    try {
      receipt = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`UAT attempt tag ${runAttempt} receipt JSON is invalid.`);
    }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      throw new Error(`UAT attempt tag ${runAttempt} receipt is not an object.`);
    verifyUatAttemptAttestation(raw, kind, runId, runAttempt);
    return receipt;
  }

  async function requireLegacyUatArtifactFallback(runId, runAttempt, kind) {
    const payload = await api(
      `/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    );
    if (!Array.isArray(payload.jobs) || !Number.isSafeInteger(payload.total_count) ||
      payload.total_count !== payload.jobs.length)
      throw new Error(`UAT ${kind} attempt ${runAttempt} job history is incomplete.`);
    const writerName = UAT_ATTEMPT_RECEIPT_WRITER_NAMES[kind];
    if (payload.jobs.some((job) => job.name === writerName))
      throw new Error(`UAT ${kind} attempt ${runAttempt} is missing its required durable receipt tag.`);
  }

  async function oneChatReleaseReceipt(runId, runAttempt, runRecord = null) {
    if (!Number.isSafeInteger(runAttempt) || runAttempt < 1)
      throw new Error("One Chat release has no exact workflow attempt.");
    const run = runRecord ?? await api(`/actions/runs/${runId}`);
    if (run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== runAttempt)
      throw new Error(`UAT One Chat attempt ${runAttempt} workflow did not finish successfully.`);
    let receipt = await durableUatAttemptReceipt(runId, runAttempt, "one-chat");
    if (!receipt) {
      await requireLegacyUatArtifactFallback(runId, runAttempt, "one-chat");
      const artifactName = `uat-one-chat-backend-release-${runAttempt}`;
      const payload = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
      const artifacts = (payload.artifacts || []).filter((artifact) =>
        artifact.name === artifactName && artifact.expired !== true,
      );
      if (artifacts.length !== 1 || !Number.isSafeInteger(artifacts[0].size_in_bytes) ||
        artifacts[0].size_in_bytes < 1 || artifacts[0].size_in_bytes > 4_000_000)
        throw new Error(`UAT One Chat attempt ${runAttempt} has no unique, retained release receipt.`);
      const archive = await apiBytes(`/actions/artifacts/${artifacts[0].id}/zip`);
      if (archive.length > 4_000_000)
        throw new Error("UAT One Chat release artifact exceeds its bounded download contract.");
      try {
        receipt = JSON.parse(zipFile(archive, "uat-one-chat-release.json", "One Chat release artifact"));
      } catch (error) {
        throw new Error(`UAT One Chat release receipt could not be verified: ${error.message}`);
      }
    }
    const sha = receipt.target_sha;
    if (receipt.status !== "success" || receipt.project !== "hushh-pda-uat" ||
      receipt.region !== "us-central1" || receipt.service !== "consent-protocol" ||
      String(receipt.run_id) !== String(runId) || receipt.attempt !== runAttempt ||
      !/^[0-9a-f]{40}$/.test(String(sha)) ||
      !receipt.final_serving_revision ||
      !receipt.final_traffic || receipt.final_traffic[receipt.final_serving_revision] !== 100 ||
      Object.keys(receipt.final_traffic).length !== 1 ||
      !/^gcr\.io\/hushh-pda-uat\/consent-protocol@sha256:[0-9a-f]{64}$/.test(String(receipt.image)))
      throw new Error(`UAT One Chat attempt ${runAttempt} release receipt is incomplete or mismatched.`);
    const mainTip = git("rev-parse", "origin/main");
    if (!isAncestor(sha, mainTip))
      throw new Error(`UAT One Chat attempt ${runAttempt} source is not reachable from current Main.`);
    return receipt;
  }

  async function fullUatReleaseAcceptance(runId, runAttempt, runRecord = null) {
    if (!Number.isSafeInteger(runAttempt) || runAttempt < 1)
      throw new Error("Full UAT release has no exact workflow attempt.");
    const run = runRecord ?? await api(`/actions/runs/${runId}`);
    if (run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== runAttempt)
      throw new Error(`Full UAT attempt ${runAttempt} workflow did not finish successfully.`);
    let receipt = await durableUatAttemptReceipt(runId, runAttempt, "full");
    if (!receipt) {
      await requireLegacyUatArtifactFallback(runId, runAttempt, "full");
      const artifactName = `release-acceptance-uat-${runId}-${runAttempt}`;
      const payload = await api(`/actions/runs/${runId}/artifacts?per_page=100`);
      const artifacts = (payload.artifacts || []).filter((artifact) =>
        artifact.name === artifactName && artifact.expired !== true,
      );
      if (artifacts.length !== 1 || !Number.isSafeInteger(artifacts[0].size_in_bytes) ||
        artifacts[0].size_in_bytes < 1 || artifacts[0].size_in_bytes > 4_000_000)
        throw new Error(`Full UAT attempt ${runAttempt} has no unique, retained acceptance receipt.`);
      const archive = await apiBytes(`/actions/artifacts/${artifacts[0].id}/zip`);
      if (archive.length > 4_000_000)
        throw new Error("Full UAT acceptance artifact exceeds its bounded download contract.");
      try {
        receipt = JSON.parse(zipFile(archive, "acceptance.json", "Full UAT acceptance artifact"));
      } catch (error) {
        throw new Error(`Full UAT acceptance receipt could not be verified: ${error.message}`);
      }
    }
    const release = receipt.release;
    const sha = release?.sha;
    const scope = release?.scope;
    const resolved = [...(receipt.resolved_services || [])].sort();
    const expectedResolved = scope === "all" ? ["backend", "frontend"] : [scope];
    const final = release?.final || {};
    const serviceHeads = {
      backend: final.backend_sha,
      frontend: final.frontend_sha,
    };
    if (receipt.schema_version !== 1 || receipt.repository !== repository ||
      receipt.workflow !== FULL_UAT_WORKFLOW || receipt.environment !== "uat" || receipt.target !== "uat" ||
      String(receipt.run_id) !== String(runId) || receipt.run_attempt !== runAttempt ||
      release?.status !== "healthy" || release.release_failed !== false ||
      !/^[0-9a-f]{40}$/.test(String(sha)) || !["all", "backend", "frontend"].includes(scope) ||
      JSON.stringify(resolved) !== JSON.stringify(expectedResolved) ||
      !receipt.classification || receipt.classification.status !== "healthy" ||
      receipt.classification.release_failed !== false ||
      !Array.isArray(receipt.classification.blocking_classifications) ||
      receipt.classification.blocking_classifications.length !== 0 ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(final.backend_revision)) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(final.frontend_revision)) ||
      !/^[0-9a-f]{40}$/.test(String(serviceHeads.backend)) ||
      !/^[0-9a-f]{40}$/.test(String(serviceHeads.frontend)) ||
      expectedResolved.some((service) => serviceHeads[service] !== sha))
      throw new Error(`Full UAT attempt ${runAttempt} acceptance receipt is incomplete or mismatched.`);
    const mainTip = git("rev-parse", "origin/main");
    if (!isAncestor(sha, mainTip) || Object.values(serviceHeads).some((source) => !isAncestor(source, mainTip)))
      throw new Error(`Full UAT attempt ${runAttempt} source is not reachable from current Main.`);
    return { targetSha: sha, scope, serviceHeads, latestMutationId: null };
  }


    return { oneChatReleaseReceipt, fullUatReleaseAcceptance };
  }
