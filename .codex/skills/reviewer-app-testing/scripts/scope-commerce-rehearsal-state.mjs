import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { commerceEvidence, exactKeys, validateFixture, uuid, opaqueId } from "./scope-commerce-rehearsal-contract.mjs";

const ROLES = ["primary", "counterpart"];
const RECORD_KEYS = ["kind", "seller", "buyer", "priceCents", "operationId", "bundleId", "requestId", "quoteId", "purchaseId", "recipientFingerprint", "approvedAt", "activationMs", "expiryMs", "stage", "checks", "refundedCents", "revokedBeforeMs", "revokedAfterMs", "buyerBalanceBeforeRevocation"];
const STAGES = ["new", "requested", "approved", "reserved", "staged", "read", "revoked", "matured"];
const CHECKS = ["inactive", "preactivation", "exactReadback", "sameSessionNavigation", "coldRecovery", "refund", "maturity"];

export function recordPurpose(state, record) {
  return `Synthetic paid sharing rehearsal ${state.runId} ${record.kind}`;
}

export function actionId(state, type, role, reference, cents) {
  return createHash("sha256").update(JSON.stringify([
    state.runId, state.appOrigin, state.platformAccountId, type, role, reference, cents,
  ])).digest("hex").slice(0, 32);
}

function validateRecord(record) {
  commerceEvidence(exactKeys(record, RECORD_KEYS) &&
    ["oneCent", "earlyRevocation", "manualMaturity", "automaticMaturity"].includes(record.kind) &&
    ROLES.includes(record.seller) && ROLES.includes(record.buyer) && record.seller !== record.buyer &&
    [1, 450].includes(record.priceCents) && uuid(record.operationId) && STAGES.includes(record.stage) &&
    Array.isArray(record.checks) && record.checks.every(check => CHECKS.includes(check)), "CHECKPOINT_RECORD_INVALID");
  commerceEvidence(record.priceCents === (record.kind === "oneCent" ? 1 : 450) &&
    record.seller === (record.kind === "automaticMaturity" ? "counterpart" : "primary"), "CHECKPOINT_SCENARIO_CHANGED");
  for (const key of ["bundleId", "quoteId", "purchaseId"]) {
    commerceEvidence(record[key] === undefined || uuid(record[key]), "CHECKPOINT_REFERENCE_INVALID");
  }
  commerceEvidence(record.requestId === undefined || opaqueId(record.requestId), "CHECKPOINT_REFERENCE_INVALID");
  commerceEvidence(record.recipientFingerprint === undefined || /^sha256:[a-f0-9]{64}$/.test(record.recipientFingerprint), "CHECKPOINT_FINGERPRINT_INVALID");
  for (const key of ["approvedAt", "activationMs", "expiryMs", "revokedBeforeMs", "revokedAfterMs", "refundedCents", "buyerBalanceBeforeRevocation"]) {
    commerceEvidence(record[key] === undefined || Number.isSafeInteger(record[key]) && record[key] >= 0,
      "CHECKPOINT_NUMBER_INVALID");
  }
}

function validateMoneyRecord(record) {
  commerceEvidence(exactKeys(record, ["operationId", "id", "cents", "status", "coldRecovery"]) &&
    uuid(record.operationId) && (record.id === undefined || uuid(record.id)) &&
    Number.isSafeInteger(record.cents) && record.cents >= 0 && record.cents <= 2000 &&
    ["new", "hosted", "succeeded", "pending"].includes(record.status) &&
    (record.coldRecovery === undefined || typeof record.coldRecovery === "boolean"), "CHECKPOINT_MONEY_INVALID");
}

/** Strict checkpoint projection excludes tokens, ciphertext, payloads, UIDs and keys. */
export function validateCommerceState(state) {
  commerceEvidence(exactKeys(state, ["version", "runId", "appOrigin", "platformAccountId", "schemaHead", "fixtures", "records", "funding", "refunds", "withdrawals", "checks"]) &&
    state.version === 1 && uuid(state.runId) && /^acct_[A-Za-z0-9]+$/.test(state.platformAccountId) &&
    Number.isSafeInteger(state.schemaHead) && new URL(state.appOrigin).origin === state.appOrigin,
  "CHECKPOINT_INVALID");
  commerceEvidence(exactKeys(state.fixtures, ROLES) && exactKeys(state.funding, ROLES) &&
    exactKeys(state.refunds, ROLES) && exactKeys(state.withdrawals, ROLES), "CHECKPOINT_ROLE_INVALID");
  for (const role of ROLES) {
    commerceEvidence(exactKeys(state.fixtures[role], ["synthetic", "personRef", "scopeRef", "scopeHandle", "machineScope", "expectedPayloadSha256"]), "CHECKPOINT_FIXTURE_INVALID");
    validateFixture(state.fixtures[role]);
    for (const group of ["funding", "refunds", "withdrawals"]) {
      commerceEvidence(Array.isArray(state[group][role]) && state[group][role].length <= 20, "CHECKPOINT_MONEY_LIMIT");
      state[group][role].forEach(validateMoneyRecord);
    }
  }
  commerceEvidence(Array.isArray(state.records) && state.records.length === 4 &&
    new Set(state.records.map(record => record.kind)).size === 4, "CHECKPOINT_RECORD_LIMIT");
  state.records.forEach(validateRecord);
  commerceEvidence(Array.isArray(state.checks) && state.checks.every(check =>
    ["pairBound", "manualAdmissionPause", "automaticAdmissionResumed", "providerReceipts", "liabilitiesBalanced", "feesConserved", "settledBacking"].includes(check)), "CHECKPOINT_CHECK_INVALID");
  return state;
}

export function newCommerceState({ appOrigin, platformAccountId, schemaHead, fixtures }) {
  return validateCommerceState({ version: 1, runId: randomUUID(), appOrigin, platformAccountId, schemaHead, fixtures,
    records: [
      { kind: "oneCent", seller: "primary", buyer: "counterpart", priceCents: 1 },
      { kind: "earlyRevocation", seller: "primary", buyer: "counterpart", priceCents: 450 },
      { kind: "manualMaturity", seller: "primary", buyer: "counterpart", priceCents: 450 },
      { kind: "automaticMaturity", seller: "counterpart", buyer: "primary", priceCents: 450 },
    ].map(record => ({ ...record, operationId: randomUUID(), stage: "new", checks: [] })),
    funding: { primary: [], counterpart: [] }, refunds: { primary: [], counterpart: [] },
    withdrawals: { primary: [], counterpart: [] }, checks: [],
  });
}

async function checkpointPath(repoRoot, filename) {
  const directory = path.resolve(repoRoot, "tmp/scope-commerce-rehearsal");
  const target = path.resolve(filename);
  commerceEvidence(path.dirname(target) === directory && opaqueId(path.basename(target, ".json")) &&
    target.endsWith(".json"), "IGNORED_CHECKPOINT_PATH_REQUIRED");
  for (const part of [path.join(repoRoot, "tmp"), directory, target]) {
    const info = await fs.lstat(part).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    commerceEvidence(!info?.isSymbolicLink(), "CHECKPOINT_SYMLINK_DENIED");
  }
  return { directory, target };
}

export async function loadCommerceState(repoRoot, filename) {
  const { target } = await checkpointPath(repoRoot, filename);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    commerceEvidence((stat.mode & 0o077) === 0 && typeof process.getuid === "function" &&
      stat.uid === process.getuid() && stat.size <= 50_000, "PRIVATE_CHECKPOINT_REQUIRED");
    return validateCommerceState(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}

export async function saveCommerceState(repoRoot, filename, state) {
  validateCommerceState(state);
  const { directory, target } = await checkpointPath(repoRoot, filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.unlink(temporary); throw error; }
  const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

/** No concurrent rehearsal may edit the same immutable intent checkpoint. */
export async function acquireCommerceStateLease(repoRoot, filename) {
  const { directory, target } = await checkpointPath(repoRoot, filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`, token = randomUUID();
  const handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(() => { commerceEvidence(false, "CHECKPOINT_ALREADY_RUNNING_OR_OPERATOR_RECOVERY_REQUIRED"); });
  try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.sync(); }
  finally { await handle.close(); }
  return async () => {
    const current = JSON.parse(await fs.readFile(lock, "utf8"));
    commerceEvidence(current.token === token, "CHECKPOINT_LOCK_CHANGED");
    await fs.unlink(lock);
  };
}
