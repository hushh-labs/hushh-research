/**
 * Typed outcomes for Profile's consequential page-local actions.
 *
 * The page's reset, marketplace, support and delete handlers used to be
 * fire-and-forget: a resolved promise, a `void` call or an early return was
 * narrated to voice as "done". Each helper here turns the owning service's
 * actual result -- or the actual reason nothing happened -- into a value both
 * the UI and the local voice wrapper consume, so the spoken outcome and the
 * screen never disagree, and "unknown" stays distinct from "failed".
 *
 * Pure and unit-tested; the page only calls these.
 */

import {
  ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE,
  AccountDeletionOutcomeUncertainError,
} from "@/lib/flows/delete-account";
import type { AccountResetResult } from "@/lib/services/account-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";

// -- reset -------------------------------------------------------------------

export type ResetOutcome = "reset" | "not_reset" | "unknown";

/**
 * Only `success && account_reset === true` is a reset. A 200 whose flags say
 * otherwise, or a malformed body, is *unknown*: the backend may or may not
 * have reset, so neither success cleanup nor "try again" is safe to imply.
 */
export function resolveResetOutcome(
  result: AccountResetResult | null | undefined,
): ResetOutcome {
  if (!result || typeof result !== "object") return "unknown";
  if (result.success === true && result.account_reset === true) return "reset";
  if (result.success === false) return "not_reset";
  return "unknown";
}

export class AccountResetNotConfirmedError extends Error {
  constructor(readonly outcome: Exclude<ResetOutcome, "reset">) {
    super(
      outcome === "not_reset"
        ? "Your account was not reset."
        : "We couldn't confirm whether your account was reset.",
    );
    this.name = "AccountResetNotConfirmedError";
  }
}

export function resetErrorMessage(error: unknown): string {
  if (error instanceof AccountResetNotConfirmedError) return error.message;
  return "Failed to reset account. Please try again.";
}

// -- marketplace visibility --------------------------------------------------

/**
 * A stated intent ("make me discoverable") is a target state; only a bare
 * "toggle" flips. Comparing against the value current at execution -- not the
 * value when the card was shown -- is what stops a delayed confirmation from
 * inverting the requested result.
 */
export function resolveMarketplaceTarget(
  raw: unknown,
  current: boolean,
): { target: boolean | null; alreadyThere: boolean } {
  const target =
    typeof raw === "boolean"
      ? raw
      : typeof raw === "string"
        ? ["true", "on", "yes", "enabled"].includes(raw.trim().toLowerCase())
          ? true
          : ["false", "off", "no", "disabled"].includes(raw.trim().toLowerCase())
            ? false
            : null
        : null;
  return { target, alreadyThere: target !== null && target === current };
}

export type MarketplaceOutcome =
  | { kind: "set"; value: boolean }
  | { kind: "failed" }
  | { kind: "no_user" };

export function marketplaceOutcomeToVoice(
  outcome: MarketplaceOutcome,
): { status: "succeeded" | "failed" | "blocked"; summary: string } {
  switch (outcome.kind) {
    case "set":
      return {
        status: "succeeded",
        summary: outcome.value
          ? "Your investor profile is now discoverable in the marketplace."
          : "Your investor profile is now hidden from the marketplace.",
      };
    case "failed":
      return { status: "failed", summary: "I couldn't update your marketplace visibility." };
    case "no_user":
      return { status: "blocked", summary: "Sign in to change your marketplace visibility." };
  }
}

// -- support -----------------------------------------------------------------

export type SupportSubmitOutcome =
  | { kind: "accepted" }
  | { kind: "too_short" }
  | { kind: "invalid_reply_email" }
  | { kind: "offline" }
  | { kind: "rejected" }
  | { kind: "failed" }
  | { kind: "busy" }
  | { kind: "no_user" };

/** Only the real service's accepted result is "sent". Everything else names why not. */
export function supportOutcomeToVoice(
  outcome: SupportSubmitOutcome,
): { status: "succeeded" | "blocked" | "failed"; summary: string } {
  switch (outcome.kind) {
    case "accepted":
      return { status: "succeeded", summary: "Sent that to support." };
    case "too_short":
      return {
        status: "blocked",
        summary: "Tell me a bit more about the problem and I will send it to support.",
      };
    case "invalid_reply_email":
      return { status: "blocked", summary: "The reply email on the form isn't valid yet." };
    case "offline":
      return { status: "blocked", summary: "You're offline. I'll send it once you reconnect." };
    case "busy":
      return { status: "blocked", summary: "A support message is already being sent." };
    case "no_user":
      return { status: "blocked", summary: "Sign in to contact support." };
    case "rejected":
    case "failed":
      return {
        status: "failed",
        summary: "I couldn't send that to support. Your message is still in the form.",
      };
  }
}

// -- deletion ----------------------------------------------------------------

export type LifecycleOutcome =
  | "deleted"
  | "needs_unlock"
  | "auth_failed"
  | "blocked_external"
  | "failed"
  | "unknown";

/** Classify what `executeVerifiedAccountDeletion` threw. */
export function classifyDeletionError(error: unknown): "blocked_external" | "failed" | "unknown" {
  if (error instanceof AccountDeletionOutcomeUncertainError) return "unknown";
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    apiErrorCode(error) === ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING_CODE
  ) {
    return "blocked_external";
  }
  return "failed";
}

export function lifecycleOutcomeToVoice(
  outcome: LifecycleOutcome,
): { status: "succeeded" | "blocked" | "failed" | "started"; summary: string } {
  switch (outcome) {
    case "deleted":
      return { status: "succeeded", summary: "Your account has been deleted." };
    case "needs_unlock":
      return {
        status: "blocked",
        summary: "Unlock your vault first, then I can delete your account.",
      };
    case "auth_failed":
      return { status: "failed", summary: "I couldn't verify your account, so nothing was deleted." };
    case "blocked_external":
      return {
        status: "blocked",
        summary:
          "Your private agent or cloud setup has to be removed before the account can be deleted. Nothing was deleted.",
      };
    case "failed":
      return { status: "failed", summary: "Account deletion failed. Nothing was deleted." };
    case "unknown":
      return {
        status: "failed",
        summary:
          "I couldn't confirm whether your account was deleted. Please sign in again to check before retrying.",
      };
  }
}
