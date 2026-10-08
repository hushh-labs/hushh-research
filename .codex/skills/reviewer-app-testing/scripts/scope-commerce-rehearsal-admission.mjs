import { commerceEvidence, exactKeys, sameJson, uuid, COMMERCE_REHEARSAL } from "./scope-commerce-rehearsal-contract.mjs";

function validOperation(body, keys) {
  return exactKeys(body, ["idempotency_key", ...keys]) && uuid(body.idempotency_key);
}

function samePreparation(body, expected) {
  const aad = body.envelope?.exportEnvelope?.aad;
  const lease = expected.lease;
  return body.preparation_id === lease.preparation_id && aad?.app_id === lease.buyer_app_id &&
    aad.grant_id === lease.grant_id && aad.export_id === lease.export_id &&
    aad.revision === lease.export_revision && aad.machine_scope === lease.machine_scope &&
    aad.scope_handle === lease.scope_handle && aad.recipient_key_fingerprint === lease.recipient_key_fingerprint &&
    aad.expires_at_ms === lease.expires_at_ms && body.envelope?.wrappedKey?.connector_key_id === lease.connector_key_id &&
    body.envelope?.sourceRevisions?.contentRevision === lease.source_revisions?.content_revision &&
    body.envelope?.sourceRevisions?.manifestRevision === lease.source_revisions?.manifest_revision;
}

function acceptsBody(capability, body) {
  const { type, expected } = capability;
  if (type === "tariff") return validOperation(body, ["scope_handle", "machine_scope", "price_cents", "base_duration_seconds"]) &&
    body.scope_handle === expected.scopeHandle && body.machine_scope === expected.machineScope &&
    body.price_cents === expected.priceCents && body.base_duration_seconds === COMMERCE_REHEARSAL.durationSeconds;
  if (type === "request") return exactKeys(body, ["person_ref", "scope_refs", "purpose", "duration_seconds", "connector_key_id", "idempotency_key"]) &&
    body.person_ref === expected.personRef && sameJson(body.scope_refs, [expected.scopeRef]) &&
    body.purpose === expected.purpose && body.duration_seconds === COMMERCE_REHEARSAL.durationSeconds &&
    body.connector_key_id === expected.connectorKeyId && body.idempotency_key === expected.operationId;
  if (type === "approval") return validOperation(body, ["duration_seconds"]) && body.duration_seconds === COMMERCE_REHEARSAL.durationSeconds;
  if (type === "opened") return exactKeys(body, ["requestId", "bundleId", "userId", "openedVia"]) &&
    body.requestId === expected.requestId && body.userId === expected.userId &&
    (!body.bundleId || body.bundleId === expected.bundleId) &&
    (!body.openedVia || ["review_button", "consent_route", "deep_link"].includes(body.openedVia));
  if (type === "quote") return validOperation(body, ["request_id", "duration_seconds"]) &&
    body.request_id === expected.requestId && body.duration_seconds === COMMERCE_REHEARSAL.durationSeconds;
  if (type === "purchase") return validOperation(body, ["quote_id", "confirmed"]) && body.quote_id === expected.quoteId && body.confirmed === true;
  if (type === "prepare") return exactKeys(body, ["source_revisions", "negative_net_acknowledgement"]) &&
    exactKeys(body.source_revisions, ["content_revision", "manifest_revision"]) &&
    Object.values(body.source_revisions).every(value => Number.isSafeInteger(value) && value >= 0) &&
    sameJson(body.negative_net_acknowledgement, expected.negativeNetAcknowledgement);
  if (type === "stage") return exactKeys(body, ["preparation_id", "envelope", "negative_net_acknowledgement"]) &&
    samePreparation(body, expected) && sameJson(body.negative_net_acknowledgement, expected.negativeNetAcknowledgement);
  if (type === "revoke") return validOperation(body, []);
  if (type === "refundPreview") return exactKeys(body, ["amount_cents"]) && body.amount_cents === expected.amountCents;
  if (type === "refund") return validOperation(body, ["amount_cents", "preview_token"]) &&
    body.amount_cents === expected.amountCents && body.preview_token === expected.previewToken;
  if (type === "withdrawal") return validOperation(body, ["preview_token"]) && body.preview_token === expected.previewToken;
  return false;
}

/** Each capability admits one exact request and its byte-equivalent retry. */
export function createCommerceMutationAdmission({ appOrigin, role }) {
  commerceEvidence(["primary", "counterpart"].includes(role), "ADMISSION_ROLE_REQUIRED");
  const capabilities = new Map();
  return {
    permit({ type, pathname, expected, beforeForward = null }) {
      commerceEvidence(typeof pathname === "string" && pathname.startsWith("/api/") && !capabilities.has(pathname), "ADMISSION_ALREADY_BOUND");
      capabilities.set(pathname, { type, expected, beforeForward, serialized: null });
    },
    replace({ type, pathname, expected, beforeForward = null }) {
      capabilities.delete(pathname);
      this.permit({ type, pathname, expected, beforeForward });
    },
    async admit(request) {
      if (new URL(request.url()).origin !== appOrigin || request.method() !== "POST") return false;
      const capability = capabilities.get(new URL(request.url()).pathname);
      if (!capability) return false;
      if (capability.type === "stage" && capability.expected.leaseReady) capability.expected.lease = await capability.expected.leaseReady;
      const body = request.postDataJSON();
      commerceEvidence(acceptsBody(capability, body), "BOUNDED_MUTATION_BINDING_MISMATCH");
      const serialized = JSON.stringify(body);
      commerceEvidence(capability.serialized === null || capability.serialized === serialized, "MUTATION_REPLAY_CHANGED");
      capability.serialized = serialized;
      if (capability.beforeForward) {
        capability.forwardReady ??= Promise.resolve().then(() => capability.beforeForward(body));
        await capability.forwardReady;
      }
      return true;
    },
  };
}
