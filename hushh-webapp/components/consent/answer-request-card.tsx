"use client";

import { answerStageTiming } from "@/lib/answers/answer-stage-timing";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { isOwnProfileNameScope } from "@/lib/pkm/identity-memory-facts";
import { answerProfilePhotoUrl, isAnswerProfilePhotoScope } from "@/lib/answers/answer-profile-photo";

/**
 * One paid-answer request inside the Consent Center, from either side.
 *
 * The owner reviews the question, narrows the scopes and sets a price. The
 * requester sees what they are about to pay for — including, before checkout,
 * that the answer is produced on the owner's device and may wait — and later
 * opens the delivered answer.
 *
 * The answer is decrypted here with the requester's own recipient key and kept
 * in component state only. It is never written to storage, never logged and
 * never sent anywhere; the server relayed ciphertext it cannot read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

import { AuthService } from "@/lib/services/auth-service";
import {
  AnswerRequestService,
  type AnswerPaymentView,
  type AnswerRequestCoverage,
  type AnswerRequestState,
  type PendingAnswerRequest,
} from "@/lib/services/answer-request-service";
import { decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { AnswerRequestReview } from "@/components/consent/answer-request-review";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import {
  runAnswerDeliverySweep,
  type AnswerSweepResult,
} from "@/lib/answers/answer-delivery-sweep";
import {
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { useAuth } from "@/hooks/use-auth";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

export interface AnswerRequestCardProps {
  requestId: string;
}

function money(cents: number | null): string {
  return cents === null ? "" : `$${(cents / 100).toFixed(0)}`;
}

function validAnswerCoverage(value: AnswerRequestCoverage | undefined): value is AnswerRequestCoverage {
  if (!value || !Array.isArray(value.included) || !Array.isArray(value.notIncluded) ||
      !value.included.length || value.included.length + value.notIncluded.length > 12) return false;
  const rows = [...value.included, ...value.notIncluded];
  if (rows.some(entry => !entry || typeof entry.scope !== "string" ||
      !/^attr\.[a-z0-9_]+(?:\.[a-z0-9_*]+)+$/.test(entry.scope) ||
      !(entry.label === null || typeof entry.label === "string" && entry.label.length <= 160))) return false;
  return new Set(rows.map(entry => entry.scope)).size === rows.length;
}

function coverageLabel(label: string | null): string {
  const clean = label?.replace(/\s+/g, " ").trim();
  return clean && !/[\u0000-\u001f\u007f]/.test(clean) ? clean.slice(0, 120) : "Requested information";
}

export function AnswerRequestCard({ requestId }: AnswerRequestCardProps) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [state, setState] = useState<AnswerRequestState | null>(null);
  const ownerRef = useRef(user?.uid);
  ownerRef.current = user?.uid;
  const requestRef = useRef(requestId);
  requestRef.current = requestId;
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const identity = `${user?.uid ?? ""}:${requestId}`;
  const loadSequence = useRef(0);
  const [pending, setPending] = useState<PendingAnswerRequest | null>(null);
  const [payment, setPayment] = useState<AnswerPaymentView | null>(null);
  // Payments are a separate rollout gate from request intake, so an approved
  // and priced request can exist in a deployment that cannot charge for it.
  // Offering Pay there is a dead control: checkout 503s. Tri-state keeps
  // "paused" distinct from "we could not ask", which need different words.
  const [payments, setPayments] = useState<"unknown" | "on" | "off">("unknown");
  const [answer, setAnswer] = useState<{
    userId: string;
    epoch: number;
    value: string;
    photo: { url: string; name: string } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Local, per-view confirmation of the owner's own last preparation attempt.
  // `requestStatus` legitimately stays "approved" after a successful prepare
  // (it only advances on payment), so this is the only signal the owner gets
  // that writing the answer actually worked, rather than nothing happening.
  const [prepareOutcome, setPrepareOutcome] = useState<
    "delivered" | "empty" | "failed" | null
  >(null);
  const [pendingOpen, setPendingOpen] = useState<{ userId: string; requestId: string } | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const load = useCallback(async () => {
    const projectionStarted = performance.now();
    const sequence = ++loadSequence.current;
    const owner = user?.uid;
    const epoch = snapshotVaultSessionEpoch();
    const valid = () =>
      sequence === loadSequence.current &&
      ownerRef.current === owner &&
      requestRef.current === requestId &&
      isVaultSessionEpochCurrent(epoch);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to open this request.");
      // The owner's copy and the requester's copy are different endpoints;
      // whichever answers is the role this person actually holds. `/payment`
      // is the requester's lane only -- the backend 404s it for the owner by
      // design, so the owner's device must never poll it at all.
      const [inbox, requestState, gates] = await Promise.all([
        AnswerRequestService.inbox(token).catch(() => []),
        AnswerRequestService.state(token, requestId),
        // Swallowed on purpose: an unreadable gate must not take down the
        // owner's review of a question, which needs no payment lane at all.
        AnswerRequestService.gates(token).catch(() => null),
      ]);
      const paid =
        requestState.role === "owner"
          ? null
          : await AnswerRequestService.payment(token, requestId).catch(() => null);
      if (!valid()) return;
      if (requestState.role === "owner") answerStageTiming(requestId, "owner_projection", projectionStarted);
      setState(requestState);
      setLoadedIdentity(`${owner ?? ""}:${requestId}`);
      setPending(inbox.find((entry) => entry.requestId === requestId) ?? null);
      setPayment(paid);
      setPayments(gates === null ? "unknown" : gates.payments ? "on" : "off");
      if (requestState.role === "requester" && !paid)
        setError("Payment status could not be checked. Refresh this question to retry.");
    } catch (cause) {
      if (valid()) {
        setLoadedIdentity(`${owner ?? ""}:${requestId}`);
        setError(
          cause instanceof Error
            ? cause.message
            : "This request could not be opened.",
        );
      }
    } finally {
      if (valid()) setLoading(false);
    }
  }, [requestId, user?.uid]);

  useEffect(() => {
    setLoading(true);
    setState(null);
    setPending(null);
    setPayment(null);
    setPayments("unknown");
    setLoadedIdentity(null);
    setBusy(false);
    setError(null);
    setPendingOpen(null);
    setUnlockOpen(false);
    setPrepareOutcome(null);
  }, [identity]);

  useEffect(() => {
    void load();
    const refresh = () => {
      void load();
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load, vaultOwnerToken]);

  useEffect(() => {
    if (!state?.role || ["answered", "cancelled", "declined", "expired"].includes(payment?.requestStatus ?? state.requestStatus)) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      if (++polls >= 40) window.clearInterval(timer);
      void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load, state?.role, state?.requestStatus, payment?.requestStatus]);

  const run = useCallback(async (
    action: (token: string, epoch: number) => Promise<unknown>,
  ) => {
    const epoch = snapshotVaultSessionEpoch();
    const owner = user?.uid;
    const valid = () =>
      ownerRef.current === owner && requestRef.current === requestId && isVaultSessionEpochCurrent(epoch);
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to continue.");
      if (!valid())
        throw new Error("Session changed. Open this request again.");
      await action(token, epoch);
      if (!valid()) return;
      if (user?.uid) CacheSyncService.onConsentMutated(user.uid);
      dispatchConsentStateChanged({
        userId: user?.uid,
        requestId: `answer_request:${requestId}`,
      });
      await load();
    } catch (cause) {
      if (valid()) setError(
        cause instanceof Error ? cause.message : "That could not be completed.",
      );
    } finally {
      if (valid()) setBusy(false);
    }
  }, [load, requestId, user?.uid]);

  // Most "Preparation could not finish" failures are a single transient
  // revision conflict (another write landed mid-read) that a fresh reread
  // clears on its own. Retrying here, bounded and automatic, is what turns
  // that into one clean attempt instead of the owner clicking Retry by hand
  // several times before it happens to land between writes.
  const PREPARE_ATTEMPTS = 3;
  const prepare = () => run(async (token, epoch) => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) throw new Error("Unlock your memory to prepare this answer.");
    setPrepareOutcome(null);
    let result: AnswerSweepResult | null = null;
    for (let attempt = 1; attempt <= PREPARE_ATTEMPTS; attempt += 1) {
      result = await runAnswerDeliverySweep({ userId: user.uid, vaultKey, vaultOwnerToken,
        firebaseIdToken: token, requestId, ownerIdentity: { displayName: user.displayName, photoUrl: user.photoURL } }, epoch);
      if (result.delivered || result.empty) break;
      if (attempt < PREPARE_ATTEMPTS) await new Promise(resolve => window.setTimeout(resolve, 500 * attempt));
    }
    if (!result || (!result.delivered && !result.empty)) {
      setPrepareOutcome("failed");
      throw new Error("Preparation could not finish. Keep your memory unlocked and retry preparation.");
    }
    setPrepareOutcome(result.delivered ? "delivered" : "empty");
  });

  const openCheckout = () =>
    run(async (token, epoch) => {
      if (!validAnswerCoverage(state?.coverage))
        throw new Error("Answer coverage could not be verified. Refresh this question before paying.");
      const url = await AnswerRequestService.checkout(token, requestId);
      // Validated as a Stripe-hosted host by the service before we get here.
      if (ownerRef.current === user?.uid && requestRef.current === requestId &&
          isVaultSessionEpochCurrent(epoch)) window.location.assign(url);
    });

  useEffect(() => {
    setAnswer(null);
  }, [user?.uid, isVaultUnlocked, vaultOwnerToken, requestId]);

  const openAnswer = useCallback(() =>
    run(async (token, epoch) => {
      const owner = user?.uid;
      if (!owner || !isVaultUnlocked)
        throw new Error("Unlock to read your answer.");
      const envelope = await AnswerRequestService.answer(token, requestId);
      if (ownerRef.current !== owner || requestRef.current !== requestId || !isVaultSessionEpochCurrent(epoch))
        return;
      // Decrypted with this person's own recipient key, held on this device.
      const decrypted = await decryptMarketplaceEnvelope({
        userId: owner,
        envelope: envelope as never,
      });
      if (ownerRef.current !== owner || requestRef.current !== requestId || !isVaultSessionEpochCurrent(epoch))
        return;
      const value = decrypted as Record<string, unknown>;
      if (value?.version !== 1 || value.answerMode !== "agent" ||
          typeof value.answer !== "string" || !value.answer.trim())
        throw new Error("This answer could not be read. Refresh the question and try again.");
      const identity = value.ownerIdentity as { photoUrl?: unknown; displayName?: unknown } | undefined;
      const scopes = Array.isArray(value.approvedScopes) ? value.approvedScopes : [];
      const photoApproved = scopes.some(scope => typeof scope === "string" && isAnswerProfilePhotoScope(scope));
      let photo: { url: string; name: string } | null = null;
      const photoUrl = photoApproved ? answerProfilePhotoUrl(identity?.photoUrl) : null;
      if (photoUrl) photo = { url: photoUrl, name: scopes.some(scope => typeof scope === "string" && isOwnProfileNameScope(scope)) && typeof identity?.displayName === "string" ? identity.displayName : "Profile" };
      setAnswer({ userId: owner, epoch, value: value.answer, photo });
    }), [isVaultUnlocked, requestId, run, user?.uid]);

  useEffect(() => {
    if (!pendingOpen) return;
    if (pendingOpen.userId !== user?.uid || pendingOpen.requestId !== requestId) {
      setPendingOpen(null);
      setUnlockOpen(false);
    } else if (isVaultUnlocked) {
      setPendingOpen(null);
      setUnlockOpen(false);
      void openAnswer();
    }
  }, [pendingOpen, user?.uid, requestId, isVaultUnlocked, vaultOwnerToken, openAnswer]);

  if (loading || loadedIdentity !== identity) {
    return (
      <SettingsRow
        title="Loading request"
        description="Opening this question."
      />
    );
  }

  // ---- owner -------------------------------------------------------------
  if (pending) {
    return (
      <AnswerRequestReview
        key={pending.requestId}
        request={pending}
        requesterLabel="The requester"
        onResolved={() => {
          dispatchConsentStateChanged({ userId: user?.uid, requestId: `answer_request:${requestId}` });
          void load();
        }}
        onApproved={() => void prepare()}
      />
    );
  }

  if (state?.role === "owner") {
    return (
      <div className="consent-presentation-surface space-y-4">
        <BodyText>{state.question}</BodyText>
        <HelperText as="p" role="status">
          {state.requestStatus === "answering"
            ? "Payment verified. Unlock and choose Write answer. Failed attempts can be retried until the 72-hour deadline; then a full refund is due."
            : state.requestStatus === "approved"
              ? busy
                ? "Preparing answer…"
                : prepareOutcome === "delivered"
                  ? "Answer prepared. They can pay once they see it."
                  : prepareOutcome === "empty"
                    ? "Answer not present in their memory. They will not be charged."
                    : "Your device prepares the approved answer while your memory is unlocked."
              : `Request ${state.requestStatus}.`}
        </HelperText>
        {["approved", "answering"].includes(state.requestStatus) ? (
          <Button
            disabled={busy || !isVaultUnlocked}
            onClick={() => void prepare()}
          >
            {busy
              ? "Preparing answer…"
              : state.requestStatus === "answering"
                ? "Write answer"
                : prepareOutcome === "failed"
                  ? "Retry preparation"
                  : "Prepare answer"}
          </Button>
        ) : null}
        {error ? <HelperText role="alert">{error}</HelperText> : null}
      </div>
    );
  }

  // ---- requester ---------------------------------------------------------
  if (payment) {
    const proposedCoverage = state?.coverage;
    const coverage = validAnswerCoverage(proposedCoverage) ? proposedCoverage : null;
    const owed =
      payment.requestStatus === "approved" &&
      (payment.orderStatus === null ||
        payment.orderStatus === "awaiting_payment" ||
        payment.orderStatus === "checkout_open");

    return (
      <div className="consent-presentation-surface min-w-0 space-y-4">
        {state?.question ? <BodyText>{state.question}</BodyText> : null}
        {coverage ? (
          <div className="space-y-1" aria-label="Priced answer coverage">
            <HelperText as="p">Included in this answer: {coverage.included.map(entry => coverageLabel(entry.label)).join(", ")}.</HelperText>
            {coverage.notIncluded.length > 0 ? (
              <HelperText as="p">Not included in this answer: {coverage.notIncluded.map(entry => coverageLabel(entry.label)).join(", ")}.</HelperText>
            ) : null}
          </div>
        ) : null}
        {owed ? (
          <>
            <BodyText>
              {money(payment.amountCents)} to answer this question.
            </BodyText>
            {payments === "on" && payment.preparationStatus === "ready" && coverage ? (
              <>
                {/* The wait is disclosed BEFORE checkout, not after. */}
                <HelperText as="p">
                  Their answer is prepared. One payment buys this answer to
                  the approved question. It is released after payment confirmation.
                </HelperText>
                <Button
                  type="button"
                  size="prominent"
                  disabled={busy}
                  onClick={() => void openCheckout()}
                >
                  {busy ? "Opening…" : `Pay ${money(payment.amountCents)}`}
                </Button>
              </>
            ) : (
              // The price stands and the request is intact; only paying is
              // unavailable. No Pay control, because checkout would 503.
              <HelperText as="p" role="status">
                {payment.preparationStatus === "retry_required"
                  ? "Preparation needs another attempt. Ask them to open this request, unlock their memory, and retry. You have not been charged."
                  : payment.preparationStatus === "empty"
                  ? "Answer not found. You have not been charged."
                  : payment.preparationStatus === "ready" && !coverage
                  ? "Answer coverage could not be verified. Refresh this question before paying. You have not been charged."
                  : payments === "on"
                    ? "Their answer is being prepared. Payment opens when it is ready."
                    : payments === "off"
                  ? "Paying for answers is not switched on here yet, so this cannot be paid for or answered. You have not been charged, and you can cancel this request."
                  : "Payment availability could not be checked just now. You have not been charged. Reopen this request to try again."}
              </HelperText>
            )}
          </>
        ) : null}

        {payment.requestStatus === "answering" ? (
          <HelperText as="p" role="status">
            Paid. Waiting for them to write the answer
            {payment.answerDeadlineAt
              ? ` — due by ${payment.answerDeadlineAt}`
              : ""}
            . Cancel for a full refund if you no longer need it.
          </HelperText>
        ) : null}

        {payment.requestStatus === "answered" ? (
          answer &&
          isVaultUnlocked &&
          answer.userId === user?.uid &&
          isVaultSessionEpochCurrent(answer.epoch) ? (
            <div className="space-y-3">
              {answer.photo ? <figure aria-label="Approved profile photo" className="flex items-center gap-3">
                <Avatar className="size-24">
                  <AvatarImage src={answer.photo.url} alt={`${answer.photo.name}'s profile photo`} referrerPolicy="no-referrer" />
                  <AvatarFallback>{Array.from(answer.photo.name)[0] ?? "P"}</AvatarFallback>
                </Avatar>
                <figcaption className="text-sm">{answer.photo.name}</figcaption>
              </figure> : null}
              <AgentMarkdown text={answer.value} />
            </div>
          ) : (
            <Button
              type="button"
              size="prominent"
              disabled={busy}
              onClick={() => {
                if (isVaultUnlocked) void openAnswer();
                else if (user) {
                  setPendingOpen({ userId: user.uid, requestId });
                  setUnlockOpen(true);
                }
              }}
            >
              {busy ? "Opening…" : "Open answer"}
            </Button>
          )
        ) : null}

        {payment.refundedAt ? (
          <HelperText as="p" role="status">
            Refunded in full ({payment.refundReason?.replaceAll("_", " ")}).
          </HelperText>
        ) : null}

        {payment.requestStatus !== "answered" &&
        payment.requestStatus !== "cancelled" ? (
          <Button
            type="button"
            size="standard"
            variant="none"
            disabled={busy}
            onClick={() =>
              void run((token) => AnswerRequestService.cancel(token, requestId))
            }
          >
            Cancel request
          </Button>
        ) : null}

        {error ? (
          <HelperText as="p" role="alert">
            {error}
          </HelperText>
        ) : null}
        <Button size="standard" variant="none" data-consent-quiet-action="true" disabled={busy} onClick={() => void load()}>Refresh question</Button>
        {user ? <VaultUnlockDialog user={user} open={unlockOpen}
          onOpenChange={(open) => { setUnlockOpen(open); if (!open) setPendingOpen(null); }}
          onSuccess={() => undefined} title="Unlock to read your answer"
          description="Your answer is sealed to your private key. Unlock to read it on this device."
          allowVaultCreation={false} presentationClassName="consent-presentation-surface" /> : null}
      </div>
    );
  }

  return (
    <div className="consent-presentation-surface"><SettingsRow title="Request unavailable" description={error || "Open this question from the list again."} />
      <Button size="standard" variant="none" data-consent-quiet-action="true" onClick={() => void load()}>Refresh question</Button>
    </div>
  );
}
