"use client";

import { useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { useAuth } from "@/hooks/use-auth";
import {
  formatPaymentMoney,
  presentRequesterPayment,
  requesterPaymentWithdrawable,
  type RequesterPaymentView,
  type RequesterPriceView,
} from "@/lib/consent/document-request-payment-view";
import { Button } from "@/lib/morphy-ux/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
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
 * CONTRACT (request-money lane): the requester's payment block inside the
 * request details panel: state and countdown from the shared presenter, Pay
 * while payable, a clear next step once expired, and Withdraw request (#23)
 * with an armed confirmation. Renders nothing when no payment applies.
 */
export function RequesterPaymentSection({ requestId, revision, payment, onChanged }: RequesterPaymentSectionProps) {
  const { user } = useAuth();
  const { getVaultOwnerToken } = useVault();
  const now = useCoarseClock(1000);
  const withdrawConfirm = useArmedAction();
  const [busy, setBusy] = useState<"pay" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The withdrawal's own reply. It may already know Stripe took the payment
  // (refund pending) before the webhook reaches the panel's next read.
  const [reply, setReply] = useState<RequesterPaymentView | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  const view = reply && !(payment && MONEY_STATES.has(payment.state)) ? reply : payment;
  if (!view || view.state === "none") return null;
  const presented = withdrawn && !MONEY_STATES.has(view.state)
    ? { title: "Request withdrawn", line: null, remaining: null, action: null }
    : presentRequesterPayment(view, now);
  const canWithdraw = !withdrawn && requesterPaymentWithdrawable(view, now);

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

  const description = [presented.line, presented.remaining].filter(Boolean).join(" · ");
  return (
    <>
      <SettingsGroup embedded title="Payment" testId="requester-payment-section">
        <div role="status" aria-live="polite">
          <SettingsRow
            title={presented.title}
            description={
              description ? <span className="tabular-nums">{description}</span> : undefined
            }
            trailingInteractive={presented.action === "pay"}
            trailing={
              presented.action === "pay" && view.amountCents !== null ? (
                <Button size="standard" disabled={busy !== null} onClick={() => void pay()}>
                  {`Pay ${formatPaymentMoney(view.amountCents)}`}
                </Button>
              ) : undefined
            }
          />
        </div>
        {canWithdraw ? (
          <SettingsRow
            title={withdrawConfirm.label("Withdraw request")}
            ariaLabel={withdrawConfirm.ariaLabel("Withdraw request")}
            tone="destructive"
            disabled={busy !== null}
            onClick={() => withdrawConfirm.activate(() => void withdraw())}
          />
        ) : null}
      </SettingsGroup>
      {error ? (
        <HelperText role="alert" className="mt-2 px-1">
          {error}
        </HelperText>
      ) : null}
    </>
  );
}
