"use client";

import { useId, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { useAuth } from "@/hooks/use-auth";
import {
  formatPaymentMoney,
  presentRequesterPayment,
  requesterPaymentTickMs,
  requesterPaymentWithdrawable,
  type RequesterPaymentView,
  type RequesterPriceView,
} from "@/lib/consent/document-request-payment-view";
import { Button } from "@/lib/morphy-ux/button";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { DriveRequestPaymentService } from "@/lib/services/drive-request-payment-service";
import { DriveSharingError, DriveSharingService } from "@/lib/services/drive-sharing-service";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

export type RequesterPaymentSectionProps = {
  requestId: string;
  revision: number;
  payment: RequesterPaymentView | null;
  price: RequesterPriceView | null;
  /** The owner's display name, for "Ask {owner} again" once the request can't be paid. */
  ownerName?: string | null;
  /** Called after Pay, Withdraw or a state change, so the panel reloads its snapshot. */
  onChanged: () => void;
};

const MONEY_STATES: ReadonlySet<string> = new Set(["paid", "refund_pending", "refunded", "partially_refunded"]);

function withdrawErrorCopy(cause: unknown): string | null {
  const code = cause instanceof DriveSharingError ? cause.code : "";
  if (code === "session_changed") return null;
  if (code === "request_paid") return "Payment or sharing already started. Refresh to see it.";
  if (code === "review_changed" || code === "request_changed" || code === "request_already_decided")
    return "This request changed. Refresh it.";
  return "Couldn't withdraw. Try again.";
}

/**
 * The device time, advanced only while the view can change on its own
 * (requesterPaymentTickMs). A settled, closed or deadline-free view
 * subscribes to no clock at all.
 */
function useRequesterPaymentNow(tickMs: number | null): number {
  const id = useId();
  const [clock, setClock] = useState(() => ({ tickMs, now: Date.now() }));
  let current = clock;
  if (clock.tickMs !== tickMs) {
    // A new cadence starts from the real time, never from an old tick.
    current = { tickMs, now: Date.now() };
    setClock(current);
  }
  usePeriodicTask(
    `requester-payment-clock:${id}`,
    tickMs ?? 1_000,
    () => setClock({ tickMs, now: Date.now() }),
    { enabled: tickMs !== null },
  );
  return current.now;
}

type PaymentBlockProps = {
  view: RequesterPaymentView;
  withdrawn: boolean;
  ownerName: string | null;
  busy: "pay" | "withdraw" | null;
  withdrawConfirm: ReturnType<typeof useArmedAction>;
  onPay: () => void;
  onWithdraw: () => void;
};

function PaymentBlock({ view, withdrawn, ownerName, busy, withdrawConfirm, onPay, onWithdraw }: PaymentBlockProps) {
  const locallyWithdrawn = withdrawn && !MONEY_STATES.has(view.state);
  const now = useRequesterPaymentNow(locallyWithdrawn ? null : requesterPaymentTickMs(view));
  const presented = locallyWithdrawn
    ? { title: "Request withdrawn", line: null, remaining: null, action: null }
    : presentRequesterPayment(view, now, { ownerName });
  const canWithdraw = !withdrawn && requesterPaymentWithdrawable(view, now);
  // Screen readers hear state changes only (window closed, paid, refund
  // pending, withdrawn), never the countdown, and not the state on opening.
  const announcement = [presented.title, presented.line].filter(Boolean).join(". ");
  const [spoken, setSpoken] = useState({ first: announcement, changed: false });
  if (!spoken.changed && announcement !== spoken.first) setSpoken({ ...spoken, changed: true });
  const description = [presented.line, presented.remaining].filter(Boolean).join(" · ");
  return (
    <>
      <SettingsGroup embedded title="Payment" testId="requester-payment-section">
        <SettingsRow
          title={presented.title}
          description={
            description ? <span className="tabular-nums">{description}</span> : undefined
          }
          trailingInteractive={presented.action === "pay"}
          trailing={
            presented.action === "pay" && view.amountCents !== null ? (
              <Button size="standard" disabled={busy !== null} onClick={onPay}>
                {`Pay ${formatPaymentMoney(view.amountCents)}`}
              </Button>
            ) : undefined
          }
        />
        {canWithdraw ? (
          <SettingsRow
            title={withdrawConfirm.label("Withdraw request")}
            ariaLabel={withdrawConfirm.ariaLabel("Withdraw request")}
            tone="destructive"
            disabled={busy !== null}
            onClick={() => withdrawConfirm.activate(onWithdraw)}
          />
        ) : null}
      </SettingsGroup>
      <span role="status" aria-live="polite" className="sr-only" data-testid="requester-payment-announcement">
        {spoken.changed || announcement !== spoken.first ? announcement : ""}
      </span>
    </>
  );
}

/**
 * CONTRACT (request-money lane): the requester's payment block inside the
 * request details panel: state and countdown from the shared presenter, Pay
 * while payable, a clear next step once expired, and Withdraw request (#23)
 * with an armed confirmation. Renders nothing when no payment applies.
 */
export function RequesterPaymentSection({ requestId, revision, payment, ownerName = null, onChanged }: RequesterPaymentSectionProps) {
  const { user } = useAuth();
  const { getVaultOwnerToken } = useVault();
  const withdrawConfirm = useArmedAction();
  const [busy, setBusy] = useState<"pay" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The withdrawal's own reply. It may already know Stripe took the payment
  // (refund pending) before the webhook reaches the panel's next read.
  const [reply, setReply] = useState<RequesterPaymentView | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  const view = reply && !(payment && MONEY_STATES.has(payment.state)) ? reply : payment;
  if (!view || view.state === "none") return null;

  const pay = async () => {
    if (busy) return;
    setBusy("pay");
    setError(null);
    try {
      const idToken = await user?.getIdToken();
      if (!idToken) throw new Error("Sign in to continue");
      window.location.assign(await DriveRequestPaymentService.checkout(idToken, requestId));
    } catch {
      setError("Checkout couldn't open. Try again.");
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    const token = getVaultOwnerToken();
    if (busy || !token) return;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!isVaultSessionEpochCurrent(epoch) || getVaultOwnerToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    setBusy("withdraw");
    setError(null);
    try {
      const result = await DriveSharingService.decide(token, requestId, "cancel", revision, guard);
      setReply(result.payment ?? null);
      setWithdrawn(true);
      onChanged();
    } catch (cause) {
      setError(withdrawErrorCopy(cause));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PaymentBlock
        view={view}
        withdrawn={withdrawn}
        ownerName={ownerName}
        busy={busy}
        withdrawConfirm={withdrawConfirm}
        onPay={() => void pay()}
        onWithdraw={() => void withdraw()}
      />
      {error ? (
        <HelperText role="alert" className="mt-2 px-1">
          {error}
        </HelperText>
      ) : null}
    </>
  );
}
