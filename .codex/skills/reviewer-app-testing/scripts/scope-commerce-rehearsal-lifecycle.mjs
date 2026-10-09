import { commerceEvidence, CommerceRehearsalWait, verifyRequest, verifyQuote, verifyPreparation,
  unusedCalendarRefund, uuid, opaqueId, COMMERCE_REHEARSAL } from "./scope-commerce-rehearsal-contract.mjs";
import { actionId, recordPurpose } from "./scope-commerce-rehearsal-state.mjs";
import { checkedCall, commercialResponse, assertNoExport, exactCommerceReadback, coldCommerceRecovery } from "./scope-commerce-rehearsal-browser.mjs";

export function requireOperatorAction(runtime, type, role, reference, cents, extra = {}) {
  const id = actionId(runtime.state, type, role, reference, cents);
  runtime.pendingAction = { id, type, role, reference, amountCents: cents, ...extra };
  if (runtime.options.approveAction !== id) throw new CommerceRehearsalWait("EXACT_OPERATOR_ACTION_REQUIRED");
  runtime.pendingAction = null;
}

export async function requestState(runtime, record, role = record.buyer) {
  const result = await checkedCall(runtime.actors[role].session, `/api/scope-commerce/requests/${record.requestId}`);
  verifyRequest(result, { ...record, purpose: recordPurpose(runtime.state, record) }, runtime.state.fixtures[record.seller], role === record.seller ? "owner" : "payer");
  if (result.purchase) commerceEvidence(result.purchase.amount_cents === record.priceCents &&
    (!record.purchaseId || result.purchase.id === record.purchaseId), "ACCEPTED_PURCHASE_BINDING_MISMATCH");
  return result;
}

async function createPaidRequest(runtime, record) {
  runtime.boundary = "exact-tariff-and-synthetic-request";
  const { state, actors } = runtime;
  const fixture = state.fixtures[record.seller];
  const seller = actors[record.seller], buyer = actors[record.buyer];
  seller.admission.replace({ type: "tariff", pathname: "/api/scope-commerce/tariffs", expected: { ...fixture, priceCents: record.priceCents } });
  const tariff = await checkedCall(seller.session, "/api/scope-commerce/tariffs", {
    idempotency_key: record.operationId, scope_handle: fixture.scopeHandle, machine_scope: fixture.machineScope,
    price_cents: record.priceCents, base_duration_seconds: COMMERCE_REHEARSAL.durationSeconds,
  });
  commerceEvidence(tariff.price_cents === record.priceCents && tariff.machine_scope === fixture.machineScope &&
    tariff.scope_handle === fixture.scopeHandle, "EXACT_TARIFF_BINDING_MISMATCH");
  const expected = { ...fixture, operationId: record.operationId, purpose: recordPurpose(state, record), connectorKeyId: buyer.connectorKeyId };
  buyer.admission.replace({ type: "request", pathname: "/api/one/information-requests", expected });
  const bundle = await checkedCall(buyer.session, "/api/one/information-requests", {
    person_ref: fixture.personRef, scope_refs: [fixture.scopeRef], purpose: expected.purpose,
    duration_seconds: COMMERCE_REHEARSAL.durationSeconds, connector_key_id: buyer.connectorKeyId,
    idempotency_key: record.operationId,
  }, { owner: true });
  commerceEvidence(uuid(bundle.bundleId) && bundle.personRef === fixture.personRef && bundle.items?.length === 1 &&
    opaqueId(bundle.items[0].requestId) && bundle.items[0].scopeRef === fixture.scopeRef, "SYNTHETIC_REQUEST_RECEIPT_MISMATCH");
  record.bundleId = bundle.bundleId; record.requestId = bundle.items[0].requestId; record.stage = "requested";
  await runtime.save();
  await requestState(runtime, record);
}

async function approveOwnerTerms(runtime, record) {
  runtime.boundary = "owner-inactive-approval";
  const seller = runtime.actors[record.seller];
  const state = await requestState(runtime, record, record.seller);
  if (!state.purchase) {
    const pathname = `/api/scope-commerce/requests/${record.requestId}/approve`;
    seller.admission.replace({ type: "approval", pathname, expected: {} });
    // The canonical Consent Center may mark this one reviewed request opened.
    seller.admission.replace({ type: "opened", pathname: "/api/consent/pending/opened", expected: {
      requestId: record.requestId, bundleId: record.bundleId, userId: runtime.identities[record.seller].reviewerUid,
    } });
    await seller.harness.navigateInApp(seller.session.page, `/one/consent?tab=requests&requestId=${record.requestId}`);
    const approve = seller.session.page.locator('[data-voice-control-id="consent_approve"]');
    await approve.waitFor({ state: "visible", timeout: 45_000 });
    commerceEvidence(await approve.count() === 1 && await seller.session.page.getByText(recordPurpose(runtime.state, record), { exact: true }).count() > 0,
      "EXACT_OWNER_REVIEW_REQUIRED");
    const completed = commercialResponse(seller.session.page, runtime.options.appOrigin, "POST", pathname);
    record.approvedAt = Date.now(); await runtime.save();
    await approve.click();
    commerceEvidence((await completed).ok(), "INACTIVE_OWNER_APPROVAL_FAILED");
  }
  const approved = await requestState(runtime, record);
  commerceEvidence(approved.purchase?.status === "awaiting_payment" && uuid(approved.purchase.id), "OWNER_APPROVAL_EXPOSED_USABLE_ACCESS");
  record.purchaseId = approved.purchase.id; record.stage = "approved";
  await assertNoExport(runtime.actors[record.buyer], record);
  if (!record.checks.includes("inactive")) record.checks.push("inactive");
  await runtime.save();
}

async function reviewAndConfirm(runtime, record) {
  runtime.boundary = "immutable-quote-and-human-confirmation";
  const buyer = runtime.actors[record.buyer];
  const status = await requestState(runtime, record);
  if (status.purchase?.status === "reserved" || status.purchase?.status === "preparing") {
    record.stage = "reserved"; await runtime.save(); return;
  }
  buyer.admission.replace({ type: "quote", pathname: "/api/scope-commerce/quotes", expected: { requestId: record.requestId } });
  await buyer.harness.navigateInApp(buyer.session.page, `/one/consent?commerceRequestId=${record.requestId}`);
  const response = commercialResponse(buyer.session.page, runtime.options.appOrigin, "POST", "/api/scope-commerce/quotes");
  await buyer.session.page.getByRole("button", { name: "Review exact price", exact: true }).click();
  const received = await response;
  commerceEvidence(received.ok(), "IMMUTABLE_QUOTE_REVIEW_FAILED");
  const quote = await received.json();
  commerceEvidence(Number.isSafeInteger(record.approvedAt), "ORIGINAL_OWNER_APPROVAL_TIME_REQUIRED");
  verifyQuote(quote, { ...record, purpose: recordPurpose(runtime.state, record) }, runtime.state.fixtures[record.seller], record.approvedAt, Date.now());
  commerceEvidence(!record.quoteId || quote.id === record.quoteId, "IMMUTABLE_QUOTE_CHANGED");
  record.quoteId = quote.id; record.recipientFingerprint = quote.recipient_key_fingerprint; await runtime.save();
  requireOperatorAction(runtime, "confirmQuote", record.buyer, quote.id, quote.amount_cents,
    { durationSeconds: quote.duration_seconds, quoteExpiresAt: quote.expires_at });
  buyer.admission.replace({ type: "purchase", pathname: "/api/scope-commerce/purchases", expected: { quoteId: quote.id } });
  const purchased = commercialResponse(buyer.session.page, runtime.options.appOrigin, "POST", "/api/scope-commerce/purchases");
  await buyer.session.page.getByRole("button", { name: `Confirm $${(record.priceCents / 100).toFixed(2)} from balance`, exact: true }).click();
  commerceEvidence((await purchased).ok(), "EXACT_QUOTE_CONFIRMATION_FAILED");
  const reserved = await requestState(runtime, record);
  commerceEvidence(reserved.purchase?.status === "reserved", "FUNDED_RESERVATION_NOT_CONFIRMED");
  record.stage = "reserved"; await runtime.save();
  await assertNoExport(buyer, record);
}

async function prepareEncryptedExport(runtime, record) {
  runtime.boundary = "recipient-bound-owner-encryption-and-staging";
  const seller = runtime.actors[record.seller];
  const state = await requestState(runtime, record, record.seller);
  if (["armed", "active", "expired"].includes(state.purchase?.status)) {
    record.activationMs = Date.parse(state.purchase.activation_at); record.expiryMs = Date.parse(state.purchase.expires_at);
    if (!record.checks.includes("preactivation")) {
      commerceEvidence(Date.now() < record.activationMs, "PREACTIVATION_PROOF_WINDOW_MISSED");
      await assertNoExport(runtime.actors[record.buyer], record);
      record.checks.push("preactivation");
    }
    record.stage = "staged"; await runtime.save(); return;
  }
  const costs = state.negative_net_acknowledgement;
  const acknowledgement = costs ? { version: 1, binding: costs.binding, acknowledged: true } : undefined;
  if (costs) requireOperatorAction(runtime, "acceptNegativeNet", record.seller, record.purchaseId, record.priceCents,
    { processingFeeMicroUsd: costs.processing_fee_micro_usd, netEarningsMicroUsd: costs.net_earnings_micro_usd });
  await seller.harness.navigateInApp(seller.session.page, `/one/consent?commerceRequestId=${record.requestId}`);
  if (costs) await seller.session.page.getByRole("checkbox", { name: /^I accept net earnings of / }).check();
  const preparePath = `/api/scope-commerce/purchases/${record.purchaseId}/prepare`;
  seller.admission.replace({ type: "prepare", pathname: preparePath, expected: { negativeNetAcknowledgement: acknowledgement } });
  const startedAt = Date.now();
  // Arm the stage guard from the real lease response before encryption ends.
  // The encrypted package remains browser/process memory and is never persisted.
  const prepared = commercialResponse(seller.session.page, runtime.options.appOrigin, "POST", preparePath).then(async response => {
    commerceEvidence(response.ok(), "OWNER_PREPARATION_FAILED");
    const lease = verifyPreparation(await response.json(), record, runtime.state.fixtures[record.seller], startedAt, Date.now());
    return lease;
  });
  void prepared.catch(() => {});
  seller.admission.replace({ type: "stage", pathname: `/api/scope-commerce/purchases/${record.purchaseId}/stage`,
    expected: { leaseReady: prepared, negativeNetAcknowledgement: acknowledgement } });
  const staged = commercialResponse(seller.session.page, runtime.options.appOrigin, "POST", `/api/scope-commerce/purchases/${record.purchaseId}/stage`);
  await seller.session.page.getByRole("button", { name: "Prepare encrypted information", exact: true }).click();
  const lease = await prepared;
  commerceEvidence((await staged).ok(), "SEALED_EXPORT_ACTIVATION_FAILED");
  record.activationMs = lease.starts_at_ms; record.expiryMs = lease.expires_at_ms; record.stage = "staged";
  await assertNoExport(runtime.actors[record.buyer], record);
  record.checks.push("preactivation"); await runtime.save();
}

async function proveActiveReadback(runtime, record) {
  runtime.boundary = "scheduled-access-and-browser-local-exact-readback";
  commerceEvidence(record.expiryMs - record.activationMs === COMMERCE_REHEARSAL.durationSeconds * 1000, "FIXED_PAID_TERM_CHANGED");
  if (Date.now() < record.activationMs) throw new CommerceRehearsalWait("WAIT_REAL_SCHEDULED_ACTIVATION", new Date(record.activationMs).toISOString());
  commerceEvidence(Date.now() < record.expiryMs, "ACTIVE_READBACK_WINDOW_MISSED");
  const buyer = runtime.actors[record.buyer];
  const state = await requestState(runtime, record);
  commerceEvidence(state.purchase.status === "active", "AUTHORITATIVE_ACCESS_NOT_ACTIVE");
  await exactCommerceReadback(buyer, record, runtime.state.fixtures[record.seller]);
  record.checks.push("exactReadback", "sameSessionNavigation");
  if (record.kind === "oneCent") {
    await coldCommerceRecovery(runtime, record.buyer, `/people/${runtime.state.fixtures[record.seller].personRef}`);
    await exactCommerceReadback(buyer, record, runtime.state.fixtures[record.seller]);
    record.checks.push("coldRecovery");
  }
  record.stage = "read"; await runtime.save();
}

async function revokeAndVerifyRefund(runtime, record) {
  runtime.boundary = "owner-revocation-and-calendar-refund";
  const seller = runtime.actors[record.seller], buyer = runtime.actors[record.buyer];
  const existing = await requestState(runtime, record);
  if (existing.purchase.status === "revoked") {
    record.revokedAfterMs = Date.parse(existing.purchase.earnings_settled_at);
    await verifyRevocationReceipt(runtime, record); return;
  }
  const previous = await checkedCall(buyer.session, "/api/scope-commerce/account");
  record.buyerBalanceBeforeRevocation = previous.balance.available_cents;
  seller.admission.replace({ type: "revoke", pathname: `/api/scope-commerce/purchases/${record.purchaseId}/revoke`, expected: {} });
  await seller.harness.navigateInApp(seller.session.page, `/one/consent?commerceRequestId=${record.requestId}`);
  await seller.session.page.getByRole("button", { name: "End sharing", exact: true }).click();
  const response = commercialResponse(seller.session.page, runtime.options.appOrigin, "POST", `/api/scope-commerce/purchases/${record.purchaseId}/revoke`);
  record.revokedBeforeMs = Date.now(); await runtime.save();
  await seller.session.page.getByRole("button", { name: "Confirm end of sharing", exact: true }).click();
  commerceEvidence((await response).ok(), "OWNER_REVOCATION_FAILED");
  record.revokedAfterMs = Date.now();
  await verifyRevocationReceipt(runtime, record);
}

async function verifyRevocationReceipt(runtime, record) {
  const buyer = runtime.actors[record.buyer];
  const state = await requestState(runtime, record);
  const refund = state.purchase.refunded_cents;
  const expected = unusedCalendarRefund(record.priceCents, record.activationMs, record.expiryMs, state.purchase.revoked_at);
  commerceEvidence(state.purchase.status === "revoked" && Number.isSafeInteger(refund) && refund === expected &&
    refund > 0 && refund < record.priceCents, "UNUSED_CALENDAR_PARTIAL_REFUND_MISMATCH");
  const current = await checkedCall(buyer.session, "/api/scope-commerce/account");
  commerceEvidence(Number.isSafeInteger(record.buyerBalanceBeforeRevocation) &&
    current.balance.available_cents - record.buyerBalanceBeforeRevocation === refund, "PURCHASE_REFUND_BALANCE_MISMATCH");
  await assertNoExport(buyer, record);
  record.refundedCents = refund; record.checks.push("refund"); record.stage = "revoked"; await runtime.save();
}

async function proveMaturity(runtime, record) {
  runtime.boundary = "real-term-maturity-and-earnings-release";
  if (Date.now() < record.expiryMs) throw new CommerceRehearsalWait("WAIT_REAL_TERM_MATURITY", new Date(record.expiryMs).toISOString());
  const state = await requestState(runtime, record);
  commerceEvidence(["expired", "completed"].includes(state.purchase.status), "PAID_TERM_NOT_ENDED");
  if (!state.purchase.earnings_settled_at) throw new CommerceRehearsalWait("WAIT_TERM_RECONCILIATION");
  await assertNoExport(runtime.actors[record.buyer], record);
  record.stage = "matured"; record.checks.push("maturity"); await runtime.save();
}

export async function advancePaidRecord(runtime, record) {
  runtime.scenario = record.kind;
  if (record.stage === "new") await createPaidRequest(runtime, record);
  if (record.stage === "requested") await approveOwnerTerms(runtime, record);
  if (record.stage === "approved") await reviewAndConfirm(runtime, record);
  if (record.stage === "reserved") await prepareEncryptedExport(runtime, record);
  if (record.stage === "staged") await proveActiveReadback(runtime, record);
  if (record.stage === "read" && record.kind === "earlyRevocation") {
    // Wait a real minute so the $4.50 refund must be partial, not rounded full.
    const earliest = record.activationMs + 60_000;
    if (Date.now() < earliest) throw new CommerceRehearsalWait("WAIT_EARNED_CALENDAR_MINUTE", new Date(earliest).toISOString());
    await revokeAndVerifyRefund(runtime, record);
  }
  if (record.stage === "read") await proveMaturity(runtime, record);
}
