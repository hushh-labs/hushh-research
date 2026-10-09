/** Bounded sandbox acceptance assertions; never payment or consent authority. */
export const COMMERCE_REHEARSAL = Object.freeze({
  durationSeconds: 3600, activationDelayMs: 300_000, quoteLifetimeMs: 900_000,
  fundingCapCents: 2000, capitalCapCents: 2500, minimumNetCents: 50,
});

export class CommerceRehearsalFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class CommerceRehearsalWait extends CommerceRehearsalFailure {
  constructor(code, nextCheckAt = null) { super(code); this.nextCheckAt = nextCheckAt; }
}

export function commerceEvidence(condition, code) {
  if (!condition) throw new CommerceRehearsalFailure(code);
}

export function opaqueId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function uuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function exactKeys(body, keys) {
  return body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).every(key => keys.includes(key));
}

export function sameJson(left, right) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function validateFixture(value) {
  commerceEvidence(value?.synthetic === true && uuid(value.personRef) && opaqueId(value.scopeRef) &&
    opaqueId(value.scopeHandle) && /^attr\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(value.machineScope) &&
    /^[a-f0-9]{64}$/.test(value.expectedPayloadSha256), "SYNTHETIC_EXACT_FIXTURE_REQUIRED");
  return Object.freeze({ ...value });
}

export function verifyProviderPreflight(proof) {
  commerceEvidence(proof?.readiness === true && proof.sandbox === true &&
    proof.account_pin_verified === true && proof.isolation_evidence_verified === true &&
    proof.isolated_environment === true && proof.isolation_evidence_kind === "operator_attestation" &&
    proof.isolation_source === "dashboard_general_sandbox",
  "SANDBOX_PROVIDER_PREFLIGHT_REQUIRED");
  commerceEvidence(proof.budgetPolicyActive === true &&
    proof.reviewerFundingCapCents === COMMERCE_REHEARSAL.fundingCapCents &&
    proof.platformCapitalCapCents === COMMERCE_REHEARSAL.capitalCapCents,
  "SERVER_SANDBOX_BUDGET_POLICY_REQUIRED");
  for (const role of ["primary", "counterpart"]) {
    const amount = proof.reviewerFundingUsedCents?.[role];
    commerceEvidence(Number.isSafeInteger(amount) && amount >= 0 &&
      amount <= COMMERCE_REHEARSAL.fundingCapCents, "REVIEWER_FUNDING_BUDGET_EXCEEDED");
  }
  commerceEvidence(Number.isSafeInteger(proof.platformCapitalUsedCents) &&
    proof.platformCapitalUsedCents >= 0 && proof.platformCapitalUsedCents <= COMMERCE_REHEARSAL.capitalCapCents,
  "OPERATING_CAPITAL_BUDGET_EXCEEDED");
  commerceEvidence(proof.ledgerProviderMatches === true, "LEDGER_PROVIDER_PROVENANCE_MISMATCH");
  return proof;
}

export function verifyApplicationReadiness(value, proof, appOrigin, expectedHead) {
  commerceEvidence(proof.appOrigin === appOrigin && value?.app_origin === appOrigin && value.environment === "sandbox" &&
    value.livemode === false && value.persisted_pin_matches === true &&
    value.platform_account_id === proof.platformAccountId,
  "APPLICATION_SANDBOX_PIN_MISMATCH");
  commerceEvidence(value.reviewer_funding_cap_cents === COMMERCE_REHEARSAL.fundingCapCents &&
    value.operating_capital_cap_cents === COMMERCE_REHEARSAL.capitalCapCents,
  "APPLICATION_SANDBOX_BUDGET_MISMATCH");
  commerceEvidence(Number.isInteger(expectedHead) && value.schema_head === expectedHead,
    "APPLICATION_SCHEMA_HEAD_MISMATCH");
}

export function verifyRequest(value, record, fixture, role) {
  commerceEvidence(value?.request_id === record.requestId && value.role === role &&
    value.machine_scope === fixture.machineScope && value.scope_handle === fixture.scopeHandle &&
    value.duration_seconds === COMMERCE_REHEARSAL.durationSeconds &&
    value.purpose === record.purpose, "COMMERCIAL_REQUEST_BINDING_MISMATCH");
}

export function verifyQuote(value, record, fixture, approvedAt, receivedAt) {
  commerceEvidence(uuid(value?.id) && value.request_id === record.requestId &&
    value.machine_scope === fixture.machineScope && value.scope_handle === fixture.scopeHandle &&
    value.duration_seconds === COMMERCE_REHEARSAL.durationSeconds && value.currency === "USD" &&
    value.amount_cents === record.priceCents && value.base_price_cents === record.priceCents &&
    value.base_duration_seconds === COMMERCE_REHEARSAL.durationSeconds && value.purpose === record.purpose &&
    value.buyer_app_id === "agent_one" &&
    /^sha256:[a-f0-9]{64}$/.test(value.recipient_key_fingerprint) &&
    (!record.recipientFingerprint || value.recipient_key_fingerprint === record.recipientFingerprint),
  "IMMUTABLE_QUOTE_BINDING_MISMATCH");
  const expiry = Date.parse(value.expires_at);
  commerceEvidence(expiry > receivedAt && expiry >= approvedAt + COMMERCE_REHEARSAL.quoteLifetimeMs - 5000 &&
    expiry <= receivedAt + COMMERCE_REHEARSAL.quoteLifetimeMs + 5000, "QUOTE_CALENDAR_WINDOW_MISMATCH");
}

export function verifyPreparation(lease, record, fixture, startedAt, receivedAt) {
  commerceEvidence(uuid(lease?.preparation_id) && lease.grant_id === record.requestId &&
    lease.machine_scope === fixture.machineScope && lease.scope_handle === fixture.scopeHandle &&
    lease.recipient_key_fingerprint === record.recipientFingerprint &&
    /^sha256:[a-f0-9]{64}$/.test(lease.recipient_key_fingerprint), "PREPARATION_BINDING_MISMATCH");
  commerceEvidence(Number.isSafeInteger(lease.starts_at_ms) &&
    lease.starts_at_ms >= startedAt + COMMERCE_REHEARSAL.activationDelayMs - 5000 &&
    lease.starts_at_ms <= receivedAt + COMMERCE_REHEARSAL.activationDelayMs + 5000 &&
    lease.expires_at_ms - lease.starts_at_ms === COMMERCE_REHEARSAL.durationSeconds * 1000,
  "FIXED_ACTIVATION_WINDOW_MISMATCH");
  return lease;
}

export function unusedCalendarRefund(priceCents, activationMs, expiryMs, revokedMs) {
  commerceEvidence(Number.isSafeInteger(priceCents) && priceCents >= 1 &&
    expiryMs - activationMs === COMMERCE_REHEARSAL.durationSeconds * 1000,
  "REFUND_TERM_INVALID");
  const duration = BigInt(COMMERCE_REHEARSAL.durationSeconds);
  const revoked = timestampMicroseconds(revokedMs);
  const remaining = BigInt(expiryMs) * 1000n - revoked;
  const seconds = remaining <= 0n ? 0n : remaining / 1_000_000n;
  const bounded = seconds > duration ? duration : seconds;
  return Number((2n * BigInt(priceCents) * bounded + duration) / (2n * duration));
}

function timestampMicroseconds(value) {
  if (Number.isSafeInteger(value)) return BigInt(value) * 1000n;
  commerceEvidence(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), "REFUND_TIMESTAMP_INVALID");
  const millis = Date.parse(value);
  commerceEvidence(Number.isSafeInteger(millis), "REFUND_TIMESTAMP_INVALID");
  const fraction = value.match(/\.(\d{1,6})/)?.[1] || "";
  return BigInt(millis) * 1000n + BigInt(fraction.slice(3).padEnd(3, "0"));
}

export function safeCommerceFailure(error) {
  return error instanceof CommerceRehearsalFailure ? error.code : "REHEARSAL_UNEXPECTED_FAILURE";
}
