import { randomUUID } from "node:crypto";
import { commerceEvidence, CommerceRehearsalWait, uuid, COMMERCE_REHEARSAL } from "./scope-commerce-rehearsal-contract.mjs";
import { checkedCall, commercialResponse, coldCommerceRecovery } from "./scope-commerce-rehearsal-browser.mjs";
import { requireOperatorAction } from "./scope-commerce-rehearsal-lifecycle.mjs";

export async function proveExternalFunding(runtime, role, amountCents) {
  runtime.boundary = "provider-funding-receipt-and-cold-recovery";
  const retained = runtime.state.funding[role].find(item => item.cents === amountCents);
  const attempts = runtime.proof.funding?.[role]?.fundingAttempts;
  commerceEvidence(Array.isArray(attempts), "CANONICAL_FUNDING_RECEIPTS_REQUIRED");
  const candidates = attempts.filter(item => item.amountCents === amountCents &&
    ["paid", "refund_pending", "refunded"].includes(item.status) && item.providerVerified === true && item.creditedOnce === true &&
    (!retained || item.fundingId === retained.id));
  if (!candidates.length) {
    runtime.externalStep = { type: "hostedCheckout", role, amountCents, destination: "/one/profile/account",
      maximumAggregateCents: COMMERCE_REHEARSAL.fundingCapCents };
    throw new CommerceRehearsalWait("EXTERNAL_HUMAN_CHECKOUT_AND_RECEIPT_REQUIRED");
  }
  commerceEvidence(candidates.length === 1 && uuid(candidates[0].fundingId), "EXACT_FUNDING_ATTEMPT_AMBIGUOUS");
  if (retained) return;
  const actor = runtime.actors[role], id = candidates[0].fundingId;
  const destination = `/one/profile/account?commerceReturn=1&commerceAttemptId=${id}`;
  await coldCommerceRecovery(runtime, role, destination);
  const account = await checkedCall(actor.session, "/api/scope-commerce/account");
  commerceEvidence(account.managed_balances === true && account.funding_lots.some(lot => lot.id === id), "FUNDED_BALANCE_LOT_UNAVAILABLE");
  runtime.state.funding[role].push({ operationId: randomUUID(), id, cents: amountCents, status: "succeeded", coldRecovery: true });
  await runtime.save();
}

export async function requireSellerOnboarding(runtime) {
  runtime.boundary = "eligible-connect-payout-account";
  for (const role of ["primary", "counterpart"]) {
    const account = await checkedCall(runtime.actors[role].session, "/api/scope-commerce/account");
    if (!account.seller.onboarded || !account.seller.eligible || account.seller.country !== "US") {
      runtime.externalStep = { type: "hostedConnectOnboarding", role, destination: "/one/profile/account", country: "US" };
      throw new CommerceRehearsalWait("EXTERNAL_ELIGIBLE_CONNECT_ONBOARDING_REQUIRED");
    }
  }
}

function transferPreview(preview) {
  commerceEvidence(/^[a-f0-9]{64}$/.test(preview?.preview_token) && Number.isSafeInteger(preview.net_cents) &&
    Number.isSafeInteger(preview.amount_cents) && Number.isSafeInteger(preview.fee_cents), "CURRENT_TRANSFER_PREVIEW_REQUIRED");
  commerceEvidence(!preview.blocked_reason && preview.net_cents >= COMMERCE_REHEARSAL.minimumNetCents &&
    preview.net_cents >= (preview.minimum_net_cents || 0), "NET_WITHDRAWAL_THRESHOLD_OR_BACKING_BLOCKED");
}

export async function requestManualWithdrawal(runtime) {
  runtime.boundary = "human-manual-withdrawal-and-durable-intent";
  const retained = runtime.state.withdrawals.primary[0];
  if (retained) return;
  const actor = runtime.actors.primary;
  await actor.harness.navigateInApp(actor.session.page, "/one/profile/account");
  const response = commercialResponse(actor.session.page, runtime.options.appOrigin, "GET", "/api/scope-commerce/withdrawals/preview");
  await actor.session.page.getByRole("button", { name: "Review withdrawal", exact: true }).click();
  const received = await response;
  commerceEvidence(received.ok(), "MANUAL_WITHDRAWAL_PREVIEW_FAILED");
  const preview = await received.json(); transferPreview(preview);
  requireOperatorAction(runtime, "manualWithdrawal", "primary", preview.preview_token, preview.amount_cents,
    { netCents: preview.net_cents, feeCents: preview.fee_cents });
  actor.admission.replace({ type: "withdrawal", pathname: "/api/scope-commerce/withdrawals", expected: { previewToken: preview.preview_token },
    beforeForward: async body => {
      runtime.state.withdrawals.primary.push({ operationId: body.idempotency_key, id: body.idempotency_key, cents: preview.net_cents, status: "pending" });
      await runtime.save();
    } });
  const completed = commercialResponse(actor.session.page, runtime.options.appOrigin, "POST", "/api/scope-commerce/withdrawals");
  await actor.session.page.getByRole("button", { name: "Confirm withdrawal", exact: true }).click();
  const result = await completed;
  commerceEvidence(result.ok(), "MANUAL_WITHDRAWAL_SUBMISSION_FAILED");
  const value = await result.json();
  commerceEvidence(uuid(value.withdrawal_id), "MANUAL_WITHDRAWAL_REFERENCE_MISSING");
  commerceEvidence(value.withdrawal_id === runtime.state.withdrawals.primary[0].id, "DURABLE_WITHDRAWAL_REFERENCE_MISMATCH");
  await runtime.save();
}

export async function proveBankPayout(runtime, role, source) {
  runtime.boundary = `trusted-${source}-bank-payout-and-purchase-allocation`;
  const withdrawals = runtime.proof.withdrawals?.[role];
  const retained = runtime.state.withdrawals[role][0];
  const purchaseId = runtime.state.records.find(record => record.kind === (source === "weekly" ? "automaticMaturity" : "manualMaturity")).purchaseId;
  const candidate = Array.isArray(withdrawals) ? withdrawals.find(item => item.source === source &&
    Array.isArray(item.purchaseIds) && item.purchaseIds.includes(purchaseId) && (!retained || item.withdrawalId === retained.id)) : null;
  if (!candidate || candidate.status !== "succeeded" || candidate.transferVerified !== true ||
    candidate.bankPayoutVerified !== true || candidate.feeReceiptsMatched !== true) {
    runtime.externalStep = { type: "providerReconciliation", role, source, transferIsNotBankPayout: true };
    throw new CommerceRehearsalWait(source === "weekly" ? "WAIT_ACTUAL_WEEKLY_BANK_PAYOUT" : "WAIT_ACTUAL_MANUAL_BANK_PAYOUT");
  }
  commerceEvidence(uuid(candidate.withdrawalId) && Number.isSafeInteger(candidate.netCents) &&
    Number.isSafeInteger(candidate.providerMinimumCents) && candidate.netCents >= COMMERCE_REHEARSAL.minimumNetCents &&
    candidate.netCents >= candidate.providerMinimumCents, "ACTUAL_PAYOUT_THRESHOLD_MISMATCH");
  const account = await checkedCall(runtime.actors[role].session, "/api/scope-commerce/account");
  commerceEvidence(account.recent_withdrawals.some(item => item.id === candidate.withdrawalId && item.status === "succeeded" && item.fees_final === true),
    "BANK_PAYOUT_ACCOUNT_PROJECTION_MISMATCH");
  if (retained) retained.status = "succeeded";
  else runtime.state.withdrawals[role].push({ operationId: candidate.withdrawalId, id: candidate.withdrawalId, cents: candidate.netCents, status: "succeeded" });
  await runtime.save();
}

export async function refundUnusedFunding(runtime, role) {
  runtime.boundary = "human-original-source-refund-and-durable-intent";
  const actor = runtime.actors[role];
  const account = await checkedCall(actor.session, "/api/scope-commerce/account");
  if (runtime.state.refunds[role].some(item => item.status === "pending")) throw new CommerceRehearsalWait("WAIT_ORIGINAL_SOURCE_REFUND_RECEIPT");
  const lots = account.funding_lots.filter(item => item.refundable_cents > 0 &&
    runtime.state.funding[role].some(funding => funding.id === item.id));
  if (!lots.length) return;
  const lot = lots[0];
  const prefix = `/api/scope-commerce/funding/${lot.id}`;
  actor.admission.replace({ type: "refundPreview", pathname: `${prefix}/refund-preview`, expected: { amountCents: lot.refundable_cents } });
  await actor.harness.navigateInApp(actor.session.page, "/one/profile/account");
  const response = commercialResponse(actor.session.page, runtime.options.appOrigin, "POST", `${prefix}/refund-preview`);
  const review = actor.session.page.getByRole("button", { name: `Review refund of $${(lot.refundable_cents / 100).toFixed(2)}`, exact: true });
  commerceEvidence(await review.count() === 1, "EXACT_SOURCE_REFUND_SELECTION_AMBIGUOUS");
  await review.click();
  const received = await response;
  commerceEvidence(received.ok(), "SOURCE_REFUND_PREVIEW_FAILED");
  const preview = await received.json();
  commerceEvidence(preview.amount_cents === lot.refundable_cents && !preview.blocked_reason && /^[a-f0-9]{64}$/.test(preview.preview_token), "SOURCE_REFUND_PREVIEW_MISMATCH");
  requireOperatorAction(runtime, "sourceRefund", role, lot.id, lot.refundable_cents);
  actor.admission.replace({ type: "refund", pathname: `${prefix}/refund`, expected: { amountCents: lot.refundable_cents, previewToken: preview.preview_token },
    beforeForward: async body => {
      runtime.state.refunds[role].push({ operationId: body.idempotency_key, id: lot.id, cents: lot.refundable_cents, status: "pending" });
      await runtime.save();
    } });
  const completed = commercialResponse(actor.session.page, runtime.options.appOrigin, "POST", `${prefix}/refund`);
  await actor.session.page.getByRole("button", { name: "Confirm refund", exact: true }).click();
  commerceEvidence((await completed).ok(), "SOURCE_REFUND_SUBMISSION_FAILED");
  await runtime.save();
  throw new CommerceRehearsalWait("WAIT_ORIGINAL_SOURCE_REFUND_RECEIPT");
}

export async function proveSourceRefunds(runtime) {
  runtime.boundary = "verified-original-source-refund-receipts";
  for (const role of ["primary", "counterpart"]) {
    commerceEvidence(runtime.state.refunds[role].length > 0, "UNUSED_FUNDING_SOURCE_REFUND_NOT_EXERCISED");
    for (const retained of runtime.state.refunds[role]) {
      const receipt = runtime.proof.refunds?.[role]?.find(item => item.refundId === retained.operationId && item.fundingId === retained.id && item.amountCents === retained.cents);
      if (!receipt || receipt.status !== "succeeded" || receipt.providerVerified !== true || receipt.originalSourceVerified !== true) {
        throw new CommerceRehearsalWait("WAIT_ORIGINAL_SOURCE_REFUND_RECEIPT");
      }
      retained.status = "succeeded";
    }
  }
  await runtime.save();
}

export function verifyFinalFinance(runtime) {
  runtime.boundary = "canonical-financial-conservation";
  commerceEvidence(runtime.proof.feeConservationScope === "funding_allocations_and_verified_successful_transfer_payout_receipts" &&
    runtime.proof.fundingFeeAllocationConserved === true && runtime.proof.sourceFeeReceiptsMatched === true,
  "VERIFIED_FEE_CONSERVATION_SCOPE_REQUIRED");
  for (const name of ["liabilitiesBalanced", "feesConserved", "settledBacking"]) {
    commerceEvidence(runtime.proof[name] === true, `${name.replace(/([A-Z])/g, "_$1").toUpperCase()}_UNVERIFIED`);
    if (!runtime.state.checks.includes(name)) runtime.state.checks.push(name);
  }
}
