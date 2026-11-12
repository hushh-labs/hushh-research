import { ApiService } from "@/lib/services/api-service";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import {
  openRecipientPayload,
  sealRecipientPayload,
  RecipientPayloadKeyUnavailableError,
} from "@/lib/one-location/encryption";
import { OneLocationService } from "@/lib/one-location/service";
import { financeDigest } from "@/lib/finance-sharing/contract";
import { PORTFOLIO_REVIEW_CLIENT_TIMEOUT_MS } from "@/lib/utils/request-timeouts";
import {
  advisorSnapshotContext,
  advisorSnapshotSchema,
  advisorBillingSchema,
  advisorReviewSchema,
  advisorSandboxPayoutSchema,
  type AdvisorCandidate,
  type AdvisorMeeting,
  type AdvisorPlan,
  type AdvisorReview,
  type AdvisorSnapshot,
} from "./contract";

export class AdvisorReviewError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(
      (
        {
          ADVISOR_REQUEST_EXISTS:
            "You already have a request or advisor workspace with this person. Open it below.",
          ADVISOR_CONNECT_CALENDAR:
            "Connect Google Calendar and allow scheduling before booking. Your request is saved.",
          ADVISOR_CALENDAR_ACCOUNT_CHANGED:
            "Reconnect the Google Calendar account originally used for this meeting before checking or retrying. Your request is saved.",
          ADVISOR_CALENDAR_UNAVAILABLE:
            "Calendar could not confirm this step. Check its status before booking again.",
          ADVISOR_MEETING_REVIEW_REQUIRED:
            "The Calendar review expired or changed. Review this same booking again.",
          ADVISOR_CALENDAR_CONFLICT:
            "That time is no longer free. Propose another time.",
          ADVISOR_CHECK_CALENDAR:
            "Check Google Calendar before booking again. The previous result is uncertain.",
          ADVISOR_CONNECT_STRIPE:
            "Finish Stripe payout setup before offering a plan.",
          ADVISOR_TEST_BILLING_REQUIRED:
            "Advisor test billing is not available on this server yet. Your introduction is saved.",
          ADVISOR_TEST_BILLING_SETUP:
            "Advisor test billing is not available on this server yet. Your introduction is saved.",
          ADVISOR_MEETING_TIME_PASSED:
            "That time has passed. Propose a new time.",
          ADVISOR_TIME_AGREEMENT_REQUIRED:
            "Both people must agree to the time before it can be booked.",
          ADVISOR_CHECK_BILLING_STATUS:
            "Check payment status before opening another checkout.",
          ADVISOR_PAYMENT_ALREADY_PAID:
            "This offer is already paid. Check payment status for the receipt.",
          ADVISOR_BILLING_IN_PROGRESS:
            "The current checkout needs to finish or expire before you can send a new offer.",
          ADVISOR_PLAN_CHANGED:
            "The plan changed. Refresh and review its current price and terms.",
          ADVISOR_REQUEST_CHANGED:
            "This request has ended or changed. Refresh to see its current status.",
          FINANCE_SHARE_KEY_CHANGED:
            "Secure sharing changed. Ask the sender for a fresh request after unlocking One.",
          ADVISOR_NOT_ELIGIBLE:
            "This advisor is not currently available for an in-app request.",
          ADVISOR_INVITATION_EMAIL_REQUIRED:
            "A verified invitation email is needed before booking. Check your profile email.",
          ADVISOR_MEETING_CHANGED:
            "The meeting changed. Refresh and review the current time.",
          ADVISOR_MEETING_NOT_FINISHED:
            "The meeting has not finished yet.",
          ADVISOR_CALENDAR_UNCONFIRMED:
            "Calendar could not confirm this step. Check its status before booking again.",
          ADVISOR_REQUEST_NOT_ACCEPTED:
            "This review is no longer shared. Refresh to see its current status.",
          ADVISOR_REQUEST_NOT_FOUND:
            "This request is no longer available. Refresh to see your requests.",
          ADVISOR_CONNECTION_BLOCKED:
            "This connection is not available.",
          ADVISOR_RETRY_CONFLICT:
            "This request already changed. Refresh to see its current status.",
          FINANCE_ADVISOR_NOT_VERIFIED:
            "This advisor is not verified for in-app requests yet.",
          ADVISOR_BILLING_UNCONFIRMED:
            "Stripe could not confirm this payment. Check payment status before trying again.",
          ADVISOR_PAYEE_NOT_READY:
            "The advisor has not finished payout setup yet, so payment is not available.",
          ADVISOR_LOCATION_REQUIRED:
            "Enter a postal code or allow your location to search nearby.",
          ADVISOR_LOCATION_INVALID:
            "Enter a valid postal code, or allow your location, and search again.",
          ADVISOR_DIRECTORY_UNAVAILABLE:
            "Advisor search is unavailable right now. Try again shortly.",
        } as Record<string, string>
      )[code] ||
        "This step could not be confirmed. Refresh its status before trying again.",
    );
  }
}
export async function advisorRequest<T>(
  context: FinanceShareContext,
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  requireFinanceSession(context);
  const token = await context.getIdToken();
  requireFinanceSession(context);
  const response = await ApiService.apiFetch(
    `/api/one/finance/advisor-reviews${path}`,
    {
      method,
      cache: "no-store",
      signal,
      ...(path === "/portfolio-analysis" ? { timeoutMs: PORTFOLIO_REVIEW_CLIENT_TIMEOUT_MS } : {}),
      isEffectCurrent: () => context.isCurrent() && !signal?.aborted,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Hushh-Consent": context.vaultOwnerToken,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  requireFinanceSession(context);
  const value = await response.json();
  requireFinanceSession(context);
  if (!response.ok)
    throw new AdvisorReviewError(
      value?.detail?.code || "ADVISOR_UNAVAILABLE",
      response.status,
    );
  return value as T;
}
export type PreparedAdvisorReview = Awaited<ReturnType<typeof prepare>>;
async function prepare(
  context: FinanceShareContext,
  advisor: AdvisorCandidate,
  snapshot: AdvisorSnapshot,
  introduction: string,
) {
  requireFinanceSession(context);
  if (!advisor.ready || !advisor.keyId || !advisor.publicKeyJwk)
    throw new Error(
      "This advisor needs to unlock One before receiving a secure snapshot.",
    );
  const owner = await bootstrapCurrentUserLocationRecipientKey({
    ...context,
    strictRecovery: true,
  });
  requireFinanceSession(context);
  const requestId = crypto.randomUUID();
  const text = JSON.stringify(advisorSnapshotSchema.parse(snapshot));
  if (text.length > 120000)
    throw new Error(
      "This snapshot is too large to share securely. Nothing was sent.",
    );
  const aad = advisorSnapshotContext(requestId, context.userId, advisor.userId);
  const seal = async (keyId: string, publicKey: JsonWebKey) => {
    const value = await sealRecipientPayload({
      bytes: new TextEncoder().encode(text),
      context: aad,
      recipientKeyId: keyId,
      recipientPublicKeyJwk: publicKey,
    });
    requireFinanceSession(context);
    return value;
  };
  if (!owner.keyId || !owner.publicKeyJwk)
    throw new Error("Unlock One to set up secure sharing.");
  return {
    requestId,
    advisorPersonRef: advisor.personRef,
    introduction,
    durationSeconds: 604800 as const,
    approval: "connect_and_share_finance_snapshot_v1" as const,
    contentHash: await financeDigest(text),
    envelope: await seal(advisor.keyId, advisor.publicKeyJwk),
    ownerEnvelope: await seal(owner.keyId, owner.publicKeyJwk),
  };
}

export const AdvisorReviewService = {
  prepare,
  history: async (c: FinanceShareContext) => {
    const result = await advisorRequest<{ items: unknown[] }>(c, "?ui=2");
    if (!Array.isArray(result.items) || result.items.length > 50)
      throw new Error("Advisor requests could not be verified.");
    return {
      items: result.items.map((item) => advisorReviewSchema.parse(item)),
    };
  },
  view: async (c: FinanceShareContext, id: string) => {
    const result = advisorReviewSchema.parse(
      await advisorRequest(c, `/${encodeURIComponent(id)}?ui=2`),
    );
    if (
      result.id !== id ||
      ![result.ownerUserId, result.advisorUserId].includes(c.userId)
    )
      throw new Error("This request does not match your account.");
    return result;
  },
  send: (c: FinanceShareContext, body: PreparedAdvisorReview) =>
    advisorRequest<AdvisorReview>(c, "", "POST", body),
  decide: (
    c: FinanceShareContext,
    id: string,
    action: "accept" | "decline" | "withdraw" | "stop",
    requireExistingConnection = false,
  ) => advisorRequest<AdvisorReview>(c, `/${id}/decision`, "POST", {
    action,
    ...(requireExistingConnection ? { requireExistingConnection: true } : {}),
  }),
  time: (
    c: FinanceShareContext,
    id: string,
    body: { startAt: string; endAt: string; timeZone: string; expectedMeetingId: string | null },
    automatic = false,
  ) => automatic
    ? advisorRequest(c, `/${id}/meeting/action`, "POST", { action: "propose_booking", time: body })
    : advisorRequest(c, `/${id}/meeting`, "POST", body),
  meeting: (
    c: FinanceShareContext,
    id: string,
    action: "agree" | "accept_booking" | "prepare" | "confirm" | "cancel" | "complete" | "check",
    proposalId?: string,
    meetingId?: string,
  ) =>
    advisorRequest<AdvisorMeeting>(
      c,
      `/${id}/meeting/${["agree", "complete"].includes(action) ? "decision" : "action"}`,
      "POST",
      {
        action,
        proposalId: proposalId ?? null,
        ...(meetingId ? { meetingId } : {}),
      },
    ),
  offer: (c: FinanceShareContext, id: string, body: AdvisorPlan) =>
    advisorRequest(c, `/${id}/plan`, "POST", body),
  billing: async (c: FinanceShareContext, id: string, signal?: AbortSignal) =>
    advisorBillingSchema.parse(await advisorRequest(c, `/${id}/billing`, "GET", undefined, signal)),
  checkout: (c: FinanceShareContext, id: string, planRevision: number) =>
    advisorRequest<{ url: string; mode: "test" }>(
      c,
      `/${id}/checkout`,
      "POST",
      { planRevision, acceptPayment: true },
    ),
  cancelBilling: (c: FinanceShareContext, id: string) =>
    advisorRequest(c, `/${id}/billing`, "DELETE"),
  sandboxPayout: async (c: FinanceShareContext, id: string, signal?: AbortSignal) =>
    advisorSandboxPayoutSchema.parse(await advisorRequest(c, `/${id}/sandbox-payout`, "GET", undefined, signal)),
  sandboxPayoutLink: (c: FinanceShareContext, id: string, action: "onboarding" | "dashboard") =>
    advisorRequest<{ url: string; mode: "test" }>(c, `/${id}/sandbox-payout/${action}`, "POST"),
  async decrypt(
    context: FinanceShareContext,
    review: AdvisorReview,
  ): Promise<AdvisorSnapshot> {
    if (
      !review.snapshotAvailable ||
      !review.envelope ||
      ![review.ownerUserId, review.advisorUserId].includes(context.userId)
    )
      throw new Error("Snapshot access is unavailable.");
    requireFinanceSession(context);
    const args = {
      userId: context.userId,
      context: advisorSnapshotContext(
        review.id,
        review.ownerUserId,
        review.advisorUserId,
      ),
      envelope: review.envelope,
    };
    let plaintext: ArrayBuffer;
    try {
      plaintext = await openRecipientPayload(args);
    } catch (error) {
      if (!(error instanceof RecipientPayloadKeyUnavailableError)) throw error;
      const backup = (
        await OneLocationService.getState(context.vaultOwnerToken)
      ).myRecipientKey;
      requireFinanceSession(context);
      if (!backup) throw error;
      plaintext = await openRecipientPayload({
        ...args,
        recovery: { vaultKey: context.vaultKey, remoteBackup: backup },
      });
    }
    requireFinanceSession(context);
    const value = advisorSnapshotSchema.parse(
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
    if ((await financeDigest(JSON.stringify(value))) !== review.contentHash)
      throw new Error("This snapshot could not be verified.");
    const after = await AdvisorReviewService.view(context, review.id);
    if (
      !after.snapshotAvailable ||
      after.status !== review.status ||
      after.contentHash !== review.contentHash
    )
      throw new Error("Snapshot access changed.");
    requireFinanceSession(context);
    return value;
  },
};
