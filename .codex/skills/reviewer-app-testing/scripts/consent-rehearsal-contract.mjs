/** Fail-closed assertions for rehearsal evidence, never product authority. */
export class ConsentRehearsalFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function requireEvidence(condition, code) {
  if (!condition) throw new ConsentRehearsalFailure(code);
}

/** Runs inside Playwright's browser evaluation; returns no decrypted content. */
export function matchesExpectedJson(node, expected) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])]),
    );
    return value;
  };
  try { return JSON.stringify(canonical(JSON.parse(node.textContent || ""))) === JSON.stringify(canonical(expected)); }
  catch { return false; }
}

/** Browser-only comparison with an independently reviewed owner's payload digest. */
export async function matchesExpectedJsonDigest(node, expectedDigest) {
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])]),
    );
    return value;
  };
  try {
    const payload = JSON.parse(node.textContent || "");
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(payload)));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return actual === expectedDigest;
  } catch { return false; }
}

export function safeFailureCode(error) {
  return error instanceof ConsentRehearsalFailure ? error.code : "REHEARSAL_UNEXPECTED_FAILURE";
}

/** Admission for one reviewed synthetic Memory write; never product authority. */
export function createFixtureMutationAdmission(expected) {
  requireEvidence([expected?.ownerUid, expected?.domain, expected?.scope].every(
    value => typeof value === "string" && value.trim().length > 0), "FIXTURE_TARGET_REQUIRED");
  requireEvidence(["create", "update"].includes(expected.operation), "FIXTURE_OPERATION_REQUIRED");
  const sameIds = (actual, wanted) => Array.isArray(actual) && Array.isArray(wanted) &&
    actual.every(id => typeof id === "string" && id.length > 0) &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...wanted].sort());
  requireEvidence(sameIds(expected.grantIds, expected.grantIds) &&
    sameIds(expected.exportIds, expected.exportIds), "FIXTURE_IMPACT_REQUIRED");
  const target = { ...expected, grantIds: [...expected.grantIds], exportIds: [...expected.exportIds] };
  let admitted = null;
  return body => {
    const plan = body?.mutation_plan;
    const receipt = plan?.confirmation_receipt;
    requireEvidence(body?.user_id === target.ownerUid && body.domain === target.domain &&
      plan?.proposed_domain === target.domain && plan.proposed_scope === target.scope &&
      receipt?.displayed_domain === target.domain && receipt.displayed_scope === target.scope,
    "FIXTURE_TARGET_MISMATCH");
    requireEvidence(plan.operation === target.operation && typeof plan.plan_id === "string" && plan.plan_id.length > 0 &&
      receipt.plan_id === plan.plan_id && receipt.confirmed_by_user_id === target.ownerUid &&
      receipt.authorization_mode === "owner_confirmed", "FIXTURE_CONFIRMATION_MISMATCH");
    requireEvidence(sameIds(plan.affected_grant_ids, target.grantIds) &&
      sameIds(plan.affected_export_ids, target.exportIds) &&
      (!target.grantIds.length || receipt.sharing_impact_acknowledged === true), "FIXTURE_IMPACT_MISMATCH");
    const serialized = JSON.stringify(body);
    requireEvidence(admitted === null || admitted === serialized, "FIXTURE_CONFIRMATION_ALREADY_USED");
    admitted = serialized;
  };
}

export function createFixtureReviewGate() {
  let admission = null;
  return {
    review(expected) {
      requireEvidence(admission === null, "FIXTURE_REVIEW_ALREADY_BOUND");
      admission = createFixtureMutationAdmission(expected);
    },
    admit(body) {
      requireEvidence(admission !== null, "FIXTURE_REVIEW_REQUIRED");
      admission(body);
    },
  };
}

export function matchesOwnerBinding(items, ownerUid, ownerRef) {
  requireEvidence(Array.isArray(items), "OWNER_BINDING_UNAVAILABLE");
  const selected = items.filter(item => item.userId === ownerUid);
  requireEvidence(selected.length <= 1, "OWNER_BINDING_AMBIGUOUS");
  if (!selected.length) return false;
  requireEvidence(selected[0].publicPersonRef === ownerRef, "OWNER_REFERENCE_MISMATCH");
  return true;
}

export function assertGrantTiming(grant, expiry, startedAt, completedAt) {
  requireEvidence(Number.isFinite(expiry) && grant.expiresAt === expiry, "GRANT_DURATION_MISMATCH");
  requireEvidence(Number.isFinite(grant.issuedAt) && grant.issuedAt >= startedAt - 60000
    && grant.issuedAt <= completedAt + 60000 && grant.issuedAt < grant.expiresAt,
  "GRANT_ISSUANCE_TIME_MISMATCH");
}

export function assertRequestDraft(draft, expected) {
  requireEvidence(draft?.person_ref === expected.personRef, "DRAFT_RECIPIENT_MISMATCH");
  requireEvidence(draft.purpose === expected.purpose, "DRAFT_RUN_MISMATCH");
  requireEvidence(draft.duration_seconds === expected.durationSeconds, "DRAFT_DURATION_MISMATCH");
  requireEvidence(Array.isArray(draft.scope_refs) &&
    JSON.stringify([...draft.scope_refs].sort()) === JSON.stringify([...expected.scopeRefs].sort()),
  "DRAFT_FIELDS_MISMATCH");
  requireEvidence(typeof draft.idempotency_key === "string" && draft.idempotency_key.length > 0,
    "DRAFT_IDEMPOTENCY_MISSING");
}

export function createDraftAdmission(expected) {
  let admittedKey = null;
  let admittedDraft = null;
  return draft => {
    assertRequestDraft(draft, expected);
    requireEvidence(admittedKey === null || admittedKey === draft.idempotency_key,
      "CONFIRMATION_ALREADY_USED");
    const serialized = JSON.stringify(Object.entries(draft).sort(([left], [right]) => left.localeCompare(right)));
    requireEvidence(admittedDraft === null || admittedDraft === serialized, "CONFIRMED_DRAFT_CHANGED");
    admittedKey = draft.idempotency_key;
    admittedDraft = serialized;
  };
}

export function assertConfirmationReview(summary, currentStructuredText, expected) {
  const hours = (expected.durationSeconds ?? 172800) / 3600;
  requireEvidence(Number.isInteger(hours) && hours > 0 && hours <= 720,
    "CONFIRMATION_DURATION_INVALID");
  const durations = [`${hours}\\s+hours?`];
  if (hours % 24 === 0) durations.push(`${hours / 24}\\s+days?`);
  const durationPattern = new RegExp(`\\b(?:${durations.join("|")})\\b`, "i");
  requireEvidence(summary.includes(expected.displayName) && summary.includes(expected.scopeLabel) &&
    durationPattern.test(summary), "CONFIRMATION_REVIEW_INCOMPLETE");
  requireEvidence(summary.includes(expected.purpose) || currentStructuredText.includes(expected.purpose),
    "CONFIRMATION_PURPOSE_MISSING");
}

export function assertStreamProof(proof, expectedParkedAction = null) {
  requireEvidence(proof?.httpOk === true, "CHAT_HTTP_FAILURE");
  requireEvidence(proof.settled === true, "STREAM_NOT_SETTLED");
  requireEvidence(!proof.runError, "STREAM_RUN_ERROR");
  requireEvidence(!proof.malformed, "STREAM_MALFORMED_EVENT");
  const parked = expectedParkedAction && proof.aborted && proof.parkedActions.includes(expectedParkedAction);
  requireEvidence(proof.finished || parked, "STREAM_NOT_FINISHED");
}

export function assertAllStreamProofs(proofs, validatedParkedStreams) {
  for (let index = 0; index < proofs.length; index += 1) {
    assertStreamProof(proofs[index], validatedParkedStreams.get(index) || null);
  }
}

export function assertRequestState(result, expected) {
  requireEvidence(result?.ok === true, "REQUEST_STATE_READ_FAILED");
  const bundle = result.payload;
  requireEvidence(bundle?.bundleId === expected.bundleId, "REQUEST_ID_MISMATCH");
  requireEvidence(bundle.personRef === expected.personRef, "REQUEST_RECIPIENT_MISMATCH");
  requireEvidence(bundle.purpose === expected.purpose, "REQUEST_RUN_MISMATCH");
  requireEvidence(bundle.durationSeconds === expected.durationSeconds, "REQUEST_DURATION_MISMATCH");
  const items = bundle.items;
  requireEvidence(Array.isArray(items) && items.length === expected.scopeRefs.length && items.length > 0,
    "REQUEST_FIELDS_MISMATCH");
  requireEvidence(new Set(items.map(item => item.requestId)).size === items.length &&
    items.every(item => typeof item.requestId === "string" && item.requestId.length > 0),
  "REQUEST_ITEM_ID_MISSING");
  if (expected.requestIds) {
    requireEvidence(JSON.stringify(items.map(item => item.requestId).sort()) ===
      JSON.stringify([...expected.requestIds].sort()), "REQUEST_ITEM_ID_MISMATCH");
  }
  const actual = items.map(item => item.scopeRef).sort();
  requireEvidence(JSON.stringify(actual) === JSON.stringify([...expected.scopeRefs].sort()),
    "REQUEST_FIELDS_MISMATCH");
  requireEvidence(items.every(item => item.status === expected.status), "REQUEST_STATUS_MISMATCH");
  requireEvidence(bundle.cancelled === (expected.status === "cancelled"), "REQUEST_CANCELLATION_MISMATCH");
  return bundle;
}
