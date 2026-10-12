"use client";

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
  type PendingAnswerRequest,
} from "@/lib/services/answer-request-service";
import { decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { AnswerRequestReview } from "@/components/consent/answer-request-review";
import { Button } from "@/lib/morphy-ux/button";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { runAnswerDeliverySweep } from "@/lib/answers/answer-delivery-sweep";
import {
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { useAuth } from "@/hooks/use-auth";

export interface AnswerRequestCardProps {
  requestId: string;
}

function money(cents: number | null): string {
  return cents === null ? "" : `$${(cents / 100).toFixed(0)}`;
}

export function AnswerRequestCard({ requestId }: AnswerRequestCardProps) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [state, setState] = useState<{
    role: string;
    requestStatus: string;
    question: string;
  } | null>(null);
  const ownerRef = useRef(user?.uid);
  ownerRef.current = user?.uid;
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
    value: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const owner = user?.uid;
    const epoch = snapshotVaultSessionEpoch();
    const valid = () =>
      sequence === loadSequence.current &&
      ownerRef.current === owner &&
      isVaultSessionEpochCurrent(epoch);
    setLoading(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to open this request.");
      // The owner's copy and the requester's copy are different endpoints;
      // whichever answers is the role this person actually holds.
      const [inbox, paid, requestState, gates] = await Promise.all([
        AnswerRequestService.inbox(token).catch(() => []),
        AnswerRequestService.payment(token, requestId).catch(() => null),
        AnswerRequestService.state(token, requestId),
        // Swallowed on purpose: an unreadable gate must not take down the
        // owner's review of a question, which needs no payment lane at all.
        AnswerRequestService.gates(token).catch(() => null),
      ]);
      if (!valid()) return;
      setState(requestState);
      setPending(inbox.find((entry) => entry.requestId === requestId) ?? null);
      setPayment(paid);
      setPayments(gates === null ? "unknown" : gates.payments ? "on" : "off");
    } catch (cause) {
      if (valid())
        setError(
          cause instanceof Error
            ? cause.message
            : "This request could not be opened.",
        );
    } finally {
      if (valid()) setLoading(false);
    }
  }, [requestId, user?.uid]);

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

  const run = async (
    action: (token: string, epoch: number) => Promise<unknown>,
  ) => {
    const epoch = snapshotVaultSessionEpoch();
    const owner = user?.uid;
    const valid = () =>
      ownerRef.current === owner && isVaultSessionEpochCurrent(epoch);
    setBusy(true);
    setError(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to continue.");
      if (!valid())
        throw new Error("Session changed. Open this request again.");
      await action(token, epoch);
      if (!valid()) return;
      dispatchConsentStateChanged({
        userId: user?.uid,
        requestId: `answer_request:${requestId}`,
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "That could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const openCheckout = () =>
    run(async (token, epoch) => {
      const url = await AnswerRequestService.checkout(token, requestId);
      // Validated as a Stripe-hosted host by the service before we get here.
      if (isVaultSessionEpochCurrent(epoch)) window.location.assign(url);
    });

  useEffect(() => {
    setAnswer(null);
  }, [user?.uid, isVaultUnlocked, vaultOwnerToken, requestId]);

  const openAnswer = () =>
    run(async (token, epoch) => {
      const owner = user?.uid;
      if (!owner || !isVaultUnlocked)
        throw new Error("Unlock to read your answer.");
      const envelope = await AnswerRequestService.answer(token, requestId);
      if (ownerRef.current !== owner || !isVaultSessionEpochCurrent(epoch))
        return;
      // Decrypted with this person's own recipient key, held on this device.
      const decrypted = await decryptMarketplaceEnvelope({
        userId: owner,
        envelope: envelope as never,
      });
      if (ownerRef.current !== owner || !isVaultSessionEpochCurrent(epoch))
        return;
      setAnswer({
        userId: owner,
        epoch,
        value: decrypted as Record<string, unknown>,
      });
    });

  if (loading) {
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
          // Prepare the answer now, while this device is unlocked and the
          // owner is here. Nobody is asked to pay for an answer that turns
          // out not to exist, and a verified payment later releases the
          // prepared one without bringing the owner back to unlock again.
          //
          // Best effort: the request is approved either way, and the sweep
          // retries. The requester's row says the answer is being checked
          // until this reports, so a failure here never reads as "not found".
          void (async () => {
            try {
              const token = await AuthService.getIdToken();
              if (token && user?.uid && vaultKey && vaultOwnerToken)
                await runAnswerDeliverySweep(
                  {
                    userId: user.uid,
                    vaultKey,
                    vaultOwnerToken,
                    firebaseIdToken: token,
                    requestId,
                    // What the requester already sees on the profile they
                    // asked from, so the answer is a record of a person
                    // rather than a bag of fields.
                    ownerIdentity: {
                      displayName: user.displayName ?? null,
                      email: user.email ?? null,
                      photoUrl: user.photoURL ?? null,
                    },
                  },
                  snapshotVaultSessionEpoch(),
                );
            } catch {
              /* The staged answer is retried; approval already stands. */
            } finally {
              await load();
            }
          })();
        }}
      />
    );
  }

  if (state?.role === "owner") {
    return (
      <div className="space-y-4">
        <BodyText>{state.question}</BodyText>
        <HelperText as="p" role="status">
          {state.requestStatus === "answering"
            ? "Payment verified. Unlock and choose Write answer. Failed attempts can be retried until the 72-hour deadline; then a full refund is due."
            : `Request ${state.requestStatus}.`}
        </HelperText>
        {state.requestStatus === "answering" ? (
          <Button
            disabled={busy || !isVaultUnlocked}
            onClick={() =>
              void run(async (token, epoch) => {
                if (!user?.uid || !vaultKey || !vaultOwnerToken)
                  throw new Error("Unlock to write this answer.");
                const result = await runAnswerDeliverySweep(
                  {
                    userId: user.uid,
                    vaultKey,
                    vaultOwnerToken,
                    firebaseIdToken: token,
                    requestId,
                    // What the requester already sees on the profile they
                    // asked from, so the answer is a record of a person
                    // rather than a bag of fields.
                    ownerIdentity: {
                      displayName: user.displayName ?? null,
                      email: user.email ?? null,
                      photoUrl: user.photoURL ?? null,
                    },
                  },
                  epoch,
                );
                if (!result.delivered && !result.empty)
                  throw new Error(
                    "Answer not delivered. Retry while unlocked; the deadline worker refunds unresolved requests.",
                  );
              })
            }
          >
            Write answer
          </Button>
        ) : null}
        {error ? <HelperText role="alert">{error}</HelperText> : null}
      </div>
    );
  }

  // ---- requester ---------------------------------------------------------
  if (payment) {
    const owed =
      payment.requestStatus === "approved" &&
      (payment.orderStatus === null ||
        payment.orderStatus === "awaiting_payment" ||
        payment.orderStatus === "checkout_open");

    return (
      <div className="min-w-0 space-y-4">
        {owed ? (
          <>
            <BodyText>
              {money(payment.amountCents)} to answer this question.
            </BodyText>
            {payments === "on" ? (
              <>
                {/* The wait is disclosed BEFORE checkout, not after. */}
                <HelperText as="p">
                  The answer is produced on their device, so it may wait until
                  they choose Write answer after unlocking. If it is not
                  answered within {payment.answerDeadlineHours} hours, you are
                  refunded in full. You can cancel for a full refund any time
                  before it arrives.
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
                {payments === "off"
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
            <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap break-words text-sm">
              {JSON.stringify(answer.value, null, 2)}
            </pre>
          ) : (
            <Button
              type="button"
              size="prominent"
              disabled={busy}
              onClick={() => void openAnswer()}
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
      </div>
    );
  }

  return (
    <SettingsRow
      title="Request unavailable"
      description={error || "Open this question from the list again."}
    />
  );
}
