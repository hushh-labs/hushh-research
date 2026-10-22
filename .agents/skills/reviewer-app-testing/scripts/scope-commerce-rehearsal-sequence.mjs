import { commerceEvidence, CommerceRehearsalWait } from "./scope-commerce-rehearsal-contract.mjs";
import { advancePaidRecord, requestState } from "./scope-commerce-rehearsal-lifecycle.mjs";
import { requireSellerOnboarding, proveExternalFunding, requestManualWithdrawal,
  proveBankPayout, refundUnusedFunding, proveSourceRefunds, verifyFinalFinance } from "./scope-commerce-rehearsal-finance.mjs";

const CALENDAR_WAITS = ["WAIT_REAL_SCHEDULED_ACTIVATION", "WAIT_EARNED_CALENDAR_MINUTE", "WAIT_REAL_TERM_MATURITY", "WAIT_TERM_RECONCILIATION"];

function admissionEnabled(runtime) {
  const values = Object.values(runtime.actors).map(actor => actor.newActivityEnabled);
  commerceEvidence(values.every(value => value === values[0]), "APPLICATION_ADMISSION_STATE_CHANGED");
  return values[0];
}

async function advanceInitialTerms(runtime) {
  let waiting = null;
  for (const record of runtime.state.records.slice(0, 3)) {
    if (["new", "requested", "approved", "reserved"].includes(record.stage)) {
      commerceEvidence(admissionEnabled(runtime), "NEW_ACTIVITY_PAUSED_BEFORE_PREPARATION");
    }
    try { await advancePaidRecord(runtime, record); }
    catch (error) {
      if (!(error instanceof CommerceRehearsalWait) || !CALENDAR_WAITS.includes(error.code)) throw error;
      waiting = error;
    }
  }
  const manual = runtime.state.records.find(record => record.kind === "manualMaturity");
  if (manual.stage === "read") {
    if (admissionEnabled(runtime)) {
      runtime.externalStep = { type: "pauseNewProviderAdmission", keepReconciliationRunning: true,
        deadline: new Date(manual.expiryMs).toISOString() };
      throw new CommerceRehearsalWait("EXTERNAL_OPERATOR_ADMISSION_PAUSE_REQUIRED");
    }
    if (!runtime.state.checks.includes("manualAdmissionPause")) {
      commerceEvidence(Date.now() < manual.expiryMs, "MANUAL_ADMISSION_PAUSE_WINDOW_MISSED");
      runtime.state.checks.push("manualAdmissionPause"); await runtime.save();
    }
  }
  if (waiting) throw waiting;
  commerceEvidence(runtime.state.checks.includes("manualAdmissionPause"), "MANUAL_ADMISSION_PAUSE_NOT_PROVEN");
  for (const record of runtime.state.records.slice(0, 3)) await requestState(runtime, record);
}

async function manualThenAutomatic(runtime) {
  commerceEvidence(!admissionEnabled(runtime), "MANUAL_WITHDRAWAL_REQUIRES_PAUSED_NEW_ADMISSION");
  await requestManualWithdrawal(runtime);
  await proveBankPayout(runtime, "primary", "manual");
}

async function automaticTerm(runtime) {
  if (!admissionEnabled(runtime)) {
    runtime.externalStep = { type: "resumeNewProviderAdmission", keepReconciliationRunning: true };
    throw new CommerceRehearsalWait("EXTERNAL_OPERATOR_ADMISSION_RESUME_REQUIRED");
  }
  if (!runtime.state.checks.includes("automaticAdmissionResumed")) runtime.state.checks.push("automaticAdmissionResumed");
  const record = runtime.state.records.find(item => item.kind === "automaticMaturity");
  await advancePaidRecord(runtime, record);
  await proveBankPayout(runtime, "counterpart", "weekly");
}

async function sourceRefunds(runtime) {
  // Refresh original-source receipt proof before admitting another refund.
  for (const role of ["primary", "counterpart"]) {
    for (const retained of runtime.state.refunds[role].filter(item => item.status === "pending")) {
      const receipt = runtime.proof.refunds?.[role]?.find(item => item.refundId === retained.operationId &&
        item.fundingId === retained.id && item.amountCents === retained.cents);
      if (receipt?.status === "succeeded" && receipt.providerVerified === true && receipt.originalSourceVerified === true) retained.status = "succeeded";
    }
    await refundUnusedFunding(runtime, role);
  }
  await proveSourceRefunds(runtime);
}

async function verifyLifecycleEvidence(runtime) {
  for (const record of runtime.state.records) {
    const required = ["inactive", "preactivation", "exactReadback", "sameSessionNavigation",
      record.kind === "earlyRevocation" ? "refund" : "maturity"];
    if (record.kind === "oneCent") required.push("coldRecovery");
    commerceEvidence(required.every(check => record.checks.includes(check)), "LIFECYCLE_EVIDENCE_INCOMPLETE");
    const current = await requestState(runtime, record);
    const purchase = current.purchase;
    commerceEvidence(purchase && Date.parse(purchase.activation_at) === record.activationMs &&
      Date.parse(purchase.expires_at) === record.expiryMs && purchase.quote_id === record.quoteId &&
      purchase.recipient_key_fingerprint === record.recipientFingerprint && purchase.earnings_settled_at &&
      (record.kind === "earlyRevocation" ? purchase.status === "revoked" && purchase.refunded_cents === record.refundedCents
        : ["expired", "completed"].includes(purchase.status)), "FINAL_PAID_TERM_BINDING_MISMATCH");
  }
}

export async function runCommerceSequence(runtime) {
  runtime.phase = "seller-onboarding"; await requireSellerOnboarding(runtime);
  runtime.phase = "minimum-funding";
  for (const role of ["primary", "counterpart"]) await proveExternalFunding(runtime, role, 50);
  runtime.phase = "purchase-funding";
  for (const role of ["primary", "counterpart"]) await proveExternalFunding(runtime, role, 1000);
  if (runtime.state.withdrawals.primary[0]?.status !== "succeeded") {
    runtime.phase = "initial-sharing-terms"; await advanceInitialTerms(runtime);
    runtime.phase = "manual-payout"; await manualThenAutomatic(runtime);
  } else await proveBankPayout(runtime, "primary", "manual");
  runtime.phase = "weekly-payout"; await automaticTerm(runtime);
  runtime.phase = "original-source-refunds"; await sourceRefunds(runtime);
  runtime.phase = "financial-conservation"; await verifyLifecycleEvidence(runtime); verifyFinalFinance(runtime);
  await runtime.save();
}
