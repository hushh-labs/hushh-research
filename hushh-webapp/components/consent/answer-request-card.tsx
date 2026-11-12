"use client";

import { coverageLabel, validAnswerCoverage } from "@/lib/answers/answer-request-coverage";
import { answerStageTiming } from "@/lib/answers/answer-stage-timing";
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
  type AnswerRequestState,
  type PendingAnswerRequest,
} from "@/lib/services/answer-request-service";
import { decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { useAnswerRequestAction, useAnswerRequestReceiving } from "@/components/consent/use-answer-request-actions";
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
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

export interface AnswerRequestCardProps {
  requestId: string;
}

function money(cents: number | null): string {
  return cents === null ? "" : `$${(cents / 100).toFixed(0)}`;
}

export function AnswerRequestCard({ requestId }: AnswerRequestCardProps) {
  const { user, userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [state, setState] = useState<AnswerRequestState | null>(null);
  const ownerRef = useRef(userId);
  ownerRef.current = userId;
  const requestRef = useRef(requestId);
  requestRef.current = requestId;
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const identity = `${userId ?? ""}:${requestId}`;
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
  // Local confirmation also supports older backends without staged readiness.
  const [prepareOutcome, setPrepareOutcome] = useState<
    "delivered" | "empty" | "failed" | null
  >(null);
  const [pendingOpen, setPendingOpen] = useState<{ userId: string; requestId: string } | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const projectionStarted = performance.now();
    const sequence = ++loadSequence.current;
    const owner = userId;
    const epoch = snapshotVaultSessionEpoch();
    const authGeneration = getAuthSessionGeneration();
    const valid = () =>
      mounted.current && authGeneration === getAuthSessionGeneration() &&
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
      if (requestState.role === "owner" && requestState.answerPrepared === true) setError(null);
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
  }, [requestId, userId]);

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

  const run = useAnswerRequestAction({ userId, requestId, load, setBusy, setError });
  const { deviceKeyReady, openCheckout, setupReceiving } = useAnswerRequestReceiving({
    state, requestId, run, coverageVerified: validAnswerCoverage(state?.coverage),
    onUnlock: () => setUnlockOpen(true),
  });

  // Most "Preparation could not finish" failures are a single transient
  // revision conflict (another write landed mid-read) that a fresh reread
  // clears on its own. Retrying here, bounded and automatic, is what turns
  // that into one clean attempt instead of the owner clicking Retry by hand
  // several times before it happens to land between writes.
  const PREPARE_ATTEMPTS = 3;
  const prepare = () => run(async (token, epoch, current) => {
    if (!user || !userId || !vaultKey || !vaultOwnerToken) throw new Error("Unlock your memory to prepare this answer.");
    let latest = await AnswerRequestService.state(token, requestId);
    if (!current()) return;
    setState(latest);
    if (latest.answerPrepared === true) {
      setPrepareOutcome("delivered");
      return;
    }
    if (latest.requesterKeyReady === false) {
      setState(latest);
      throw new Error("The requester needs to open this question and enable secure receiving before you can prepare the answer.");
    }
    setPrepareOutcome(null);
    let result: AnswerSweepResult | null = null;
    for (let attempt = 1; attempt <= PREPARE_ATTEMPTS; attempt += 1) {
      if (!current()) return;
      result = await runAnswerDeliverySweep({ userId, vaultKey, vaultOwnerToken,
        firebaseIdToken: token, requestId, ownerIdentity: { displayName: user.displayName, photoUrl: user.photoURL } }, epoch);
      if (!current()) return;
      if (result.delivered || result.empty) break;
      latest = await AnswerRequestService.state(token, requestId);
      if (!current()) return;
      setState(latest);
      if (latest.answerPrepared === true) {
        setPrepareOutcome("delivered");
        return;
      }
      if (attempt < PREPARE_ATTEMPTS) await new Promise(resolve => window.setTimeout(resolve, 500 * attempt));
    }
    if (!result || (!result.delivered && !result.empty)) {
      if (!current()) return;
      if (latest.requesterKeyReady === false)
        throw new Error("Waiting for the requester to enable secure receiving. Your approval and price are saved.");
      setPrepareOutcome("failed");
      throw new Error("Preparation could not finish. Keep your memory unlocked and retry preparation.");
    }
    setPrepareOutcome(result.delivered ? "delivered" : "empty");
  });

  useEffect(() => {
    setAnswer(null);
  }, [userId, isVaultUnlocked, vaultOwnerToken, requestId]);

  const openAnswer = useCallback(() =>
    run(async (token, epoch, current) => {
      const owner = userId;
      if (!owner || !isVaultUnlocked)
        throw new Error("Unlock to read your answer.");
      const envelope = await AnswerRequestService.answer(token, requestId);
      if (!current())
        return;
      // Decrypted with this person's own recipient key, held on this device.
      const decrypted = await decryptMarketplaceEnvelope({
        userId: owner,
        envelope: envelope as never,
      });
      if (!current())
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
    }), [isVaultUnlocked, requestId, run, userId]);

  useEffect(() => {
    if (!pendingOpen) return;
    if (pendingOpen.userId !== userId || pendingOpen.requestId !== requestId) {
      setPendingOpen(null);
      setUnlockOpen(false);
    } else if (isVaultUnlocked) {
      setPendingOpen(null);
      setUnlockOpen(false);
      void openAnswer();
    }
  }, [pendingOpen, userId, requestId, isVaultUnlocked, vaultOwnerToken, openAnswer]);

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
          dispatchConsentStateChanged({ userId, requestId: `answer_request:${requestId}` });
          void load();
        }}
        onApproved={() => void prepare()}
      />
    );
  }

  if (state?.role === "owner") {
    const prepared = state.answerPrepared === true ||
      (state.answerPrepared === undefined && prepareOutcome === "delivered");
    return (
      <div className="consent-presentation-surface space-y-4">
        <BodyText>{state.question}</BodyText>
        <HelperText as="p" role="status">
          {prepared && ["approved", "answering"].includes(state.requestStatus)
            ? state.requestStatus === "approved"
              ? "Answer prepared. Waiting for payment."
              : "Answer prepared. Payment verified."
            : state.requestStatus === "answering"
            ? "Payment verified. Unlock and choose Write answer. Failed attempts can be retried until the 72-hour deadline; then a full refund is due."
            : state.requestStatus === "approved" && state.requesterKeyReady === false
              ? "Waiting for the requester to open this question and enable secure receiving. Your approval and price are saved."
            : state.requestStatus === "approved"
              ? busy
                ? "Preparing answer…"
                : prepareOutcome === "empty"
                    ? "Answer not present in their memory. They will not be charged."
                    : "Your device prepares the approved answer while your memory is unlocked."
              : `Request ${state.requestStatus}.`}
        </HelperText>
        {["approved", "answering"].includes(state.requestStatus) && !prepared ? (
          <Button data-consent-role="compact-action" data-voice-control-id="answer-request-prepare"
            disabled={busy || !isVaultUnlocked || state.requesterKeyReady === false}
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
        {error && !prepared ? <HelperText role="alert">{error}</HelperText> : null}
        <Button data-consent-role="compact-action" size="standard" variant="none" disabled={busy} onClick={() => void load()}>Refresh question</Button>
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
        {(state?.requesterKeyReady === false || state?.deliveryRecipientKeyId && state.deliveryRecipientKeyActive === false) && ["pending_resolution", "awaiting_owner", "approved", "answering"].includes(payment.requestStatus) ? (
          <div className="space-y-2" role="status">
            <HelperText as="p">Enable secure receiving on this device so they can prepare your answer. Your request and price are kept.</HelperText>
            <Button data-consent-role="compact-action" data-voice-control-id="answer-request-receive" disabled={busy} onClick={setupReceiving}>
              {isVaultUnlocked ? "Enable secure receiving" : "Unlock to receive"}
            </Button>
          </div>
        ) : null}
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
            {payments === "on" && payment.preparationStatus === "ready" && coverage && state?.requesterKeyReady !== false ? (
              <>
                {/* The wait is disclosed BEFORE checkout, not after. */}
                <HelperText as="p">
                  Their answer is prepared. One payment buys this answer to
                  the approved question. It is released after payment confirmation.
                </HelperText>
                {!isVaultUnlocked ? <Button data-consent-role="compact-action" data-voice-control-id="answer-request-unlock-pay" disabled={busy} onClick={() => setUnlockOpen(true)}>Unlock to pay</Button> : !deviceKeyReady ? (
                  <HelperText as="p" role="status">This device cannot receive the prepared answer. Open this question on the device that sent it before paying.</HelperText>
                ) : <Button data-consent-role="primary-action" data-voice-control-id="answer-request-pay"
                  type="button"
                  size="prominent"
                  disabled={busy}
                  onClick={() => void openCheckout()}
                >
                  {busy ? "Opening…" : `Pay ${money(payment.amountCents)}`}
                </Button>}
              </>
            ) : (
              // The price stands and the request is intact; only paying is
              // unavailable. No Pay control, because checkout would 503.
              <HelperText as="p" role="status">
                {state?.requesterKeyReady === false
                  ? "Secure receiving setup is required before they can prepare your answer. You have not been charged."
                  : payment.preparationStatus === "retry_required"
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
          answer.userId === userId &&
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
            <Button data-consent-role="primary-action"
              type="button"
              size="prominent"
              disabled={busy}
              onClick={() => {
                if (isVaultUnlocked) void openAnswer();
                else if (userId) {
                  setPendingOpen({ userId, requestId });
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
          <Button data-consent-role="compact-action"
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
        <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" disabled={busy} onClick={() => void load()}>Refresh question</Button>
        {user ? <VaultUnlockDialog user={user} open={unlockOpen}
          onOpenChange={(open) => { setUnlockOpen(open); if (!open) setPendingOpen(null); }}
          onSuccess={() => setUnlockOpen(false)} title={pendingOpen ? "Unlock to read your answer" : "Unlock secure receiving"}
          description="Unlock to receive and read your answer securely on this device."
          allowVaultCreation={!pendingOpen} presentationClassName="consent-presentation-surface" /> : null}
      </div>
    );
  }

  return (
    <div className="consent-presentation-surface"><SettingsRow title="Request unavailable" description={error || "Open this question from the list again."} />
      <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" onClick={() => void load()}>Refresh question</Button>
    </div>
  );
}
