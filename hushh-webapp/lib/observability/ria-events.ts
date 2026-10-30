"use client";

import { trackEvent } from "@/lib/observability/client";
import type { EventPayloadFor } from "@/lib/observability/events";

type VerificationPayload = EventPayloadFor<"ria_verification_status_changed">;

/**
 * Maps the advisory/verification status a submission came back with onto the
 * statuses the observability contract declares.
 *
 * The upstream service is free to add statuses, so anything unrecognised
 * settles on `submitted`: the submission demonstrably happened, and dropping
 * it would understate the funnel. Only the contract's five values are ever
 * emitted.
 */
export function riaVerificationAction(
  advisoryOutcome: string | null | undefined,
): VerificationPayload["action"] {
  const outcome = String(advisoryOutcome ?? "").trim().toLowerCase();
  switch (outcome) {
    case "verified":
      return "verified";
    case "active":
      return "active";
    case "rejected":
      return "rejected";
    case "draft":
      return "draft";
    default:
      return "submitted";
  }
}

/**
 * A rejection is an ordinary business outcome, not a failure of the flow, so
 * it is `expected_error` rather than `error`. `error` stays reserved for a
 * submission that could not be processed, which this call site never sees --
 * that path throws and is reported by `ria_onboarding_submitted`.
 */
export function riaVerificationResult(
  advisoryOutcome: string | null | undefined,
): VerificationPayload["result"] {
  return riaVerificationAction(advisoryOutcome) === "rejected"
    ? "expected_error"
    : "success";
}

/**
 * Records the verification decision an RIA onboarding submission produced.
 *
 * `ria_onboarding_submitted` says the form went in; it says nothing about what
 * came back. Verification is the step that gates a profile going live in the
 * directory, and its outcome was previously not measured at all -- the event
 * was declared in the contract and the event matrix documented an emitter in
 * `app/ria/onboarding/page.tsx` that did not exist. Any chart built on it
 * would have shown a permanent zero, indistinguishable from "nobody verified".
 */
export function trackRiaVerificationStatusChanged(
  advisoryOutcome: string | null | undefined,
): void {
  trackEvent("ria_verification_status_changed", {
    action: riaVerificationAction(advisoryOutcome),
    result: riaVerificationResult(advisoryOutcome),
  });
}
