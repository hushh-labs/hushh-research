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

export function safeFailureCode(error) {
  return error instanceof ConsentRehearsalFailure ? error.code : "REHEARSAL_UNEXPECTED_FAILURE";
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
  requireEvidence(summary.includes(expected.displayName) && summary.includes(expected.scopeLabel) &&
    /48 hours|2 days/.test(summary), "CONFIRMATION_REVIEW_INCOMPLETE");
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
  const actual = items.map(item => item.scopeRef).sort();
  requireEvidence(JSON.stringify(actual) === JSON.stringify([...expected.scopeRefs].sort()),
    "REQUEST_FIELDS_MISMATCH");
  requireEvidence(items.every(item => item.status === expected.status), "REQUEST_STATUS_MISMATCH");
  requireEvidence(bundle.cancelled === (expected.status === "cancelled"), "REQUEST_CANCELLATION_MISMATCH");
  return bundle;
}
