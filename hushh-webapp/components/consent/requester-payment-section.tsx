"use client";

import { useEffect, useId, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useCommerceSession } from "@/components/consent/use-commerce-session";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { parseDrivePackageDisclosure, type DrivePackageDisclosure } from "@/lib/consent/drive-package-disclosure";
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
import { DriveRequestPaymentService, drivePaymentErrorMessage } from "@/lib/services/drive-request-payment-service";
import { DriveSharingError, DriveSharingService } from "@/lib/services/drive-sharing-service";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { useVault } from "@/lib/vault/vault-context";

export type RequesterPaymentSectionProps = {
  requestId: string;
  revision: number;
  payment: RequesterPaymentView | null;
  price: RequesterPriceView | null;
  packageDisclosure?: DrivePackageDisclosure | null;
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
  payBlocked: boolean;
  onWithdraw: () => void;
};

function PaymentBlock({ view, withdrawn, ownerName, busy, withdrawConfirm, onPay, onWithdraw, payBlocked }: PaymentBlockProps) {
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
      <SettingsGroup embedded title="Payment" testId="requester-payment-section" className="consent-presentation-surface">
        <SettingsRow
          title={presented.title}
          description={
            description ? <span className="tabular-nums">{description}</span> : undefined
          }
          trailingInteractive={presented.action === "pay"}
          trailing={
            presented.action === "pay" && view.amountCents !== null ? (
              <Button data-consent-role="compact-action" size="standard" disabled={busy !== null || payBlocked} onClick={onPay}>
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
export function RequesterPaymentSection({ requestId, revision, payment, packageDisclosure, ownerName = null, onChanged }: RequesterPaymentSectionProps) {
  const { user, userId, capture } = useCommerceSession(`document-request:${requestId}:${revision}:${
    payment && "packageDisclosure" in payment ? payment.packageDisclosure?.packageDigest : packageDisclosure?.packageDigest
  }:${payment && "packageDisclosure" in payment ? payment.packageDisclosure?.packageRevision : packageDisclosure?.packageRevision}`);
  const { getVaultOwnerToken } = useVault();
  const withdrawConfirm = useArmedAction();
  const [busy, setBusy] = useState<"pay" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The withdrawal's own reply. It may already know Stripe took the payment
  // (refund pending) before the webhook reaches the panel's next read.
  const [reply, setReply] = useState<RequesterPaymentView | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  // Each committed account/request owns its asynchronous checkout callback.
  useEffect(() => {
    setBusy(null);
    setError(null);
    setReply(null);
    setWithdrawn(false);
  }, [userId, requestId, revision, packageDisclosure?.packageDigest, packageDisclosure?.packageRevision,
    payment?.packageDisclosure?.packageDigest, payment?.packageDisclosure?.packageRevision]);

  const view = reply && !(payment && MONEY_STATES.has(payment.state)) ? reply : payment;
  // An explicit null from the current payment view revokes any cached context.
  const disclosure = parseDrivePackageDisclosure(view && "packageDisclosure" in view
    ? view.packageDisclosure : packageDisclosure);
  const payBlocked = view?.packageDisclosureRequired === true && !disclosure;
  if (!view || view.state === "none") return null;

  const pay = async () => {
    if (busy || payBlocked) return;
    const current = capture();
    const currentView = capture(false);
    setBusy("pay");
    setError(null);
    try {
      const idToken = await user?.getIdToken();
      if (!current()) return;
      if (!idToken) throw new Error("Sign in to continue");
      const checkoutUrl = await DriveRequestPaymentService.checkout(idToken, requestId);
      if (!current()) return;
      if (typeof checkoutUrl === "string") window.location.assign(checkoutUrl);
      else onChanged();
    } catch (cause) {
      if (current()) { setError(drivePaymentErrorMessage(cause)); onChanged(); }
    } finally {
      if (currentView()) setBusy(null);
    }
  };

  const withdraw = async () => {
    const token = getVaultOwnerToken();
    if (busy || !token) return;
    const current = capture();
    const currentView = capture(false);
    const guard = () => {
      if (!current() || getVaultOwnerToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    setBusy("withdraw");
    setError(null);
    try {
      const result = await DriveSharingService.decide(token, requestId, "cancel", revision, guard);
      if (!current()) return;
      setReply(result.payment ?? null);
      setWithdrawn(true);
      onChanged();
    } catch (cause) {
      if (!current()) return;
      setError(withdrawErrorCopy(cause));
      onChanged();
    } finally {
      if (currentView()) setBusy(null);
    }
  };

  return (
    <>
      {disclosure ? <section aria-label="Approved documents" className="space-y-2 px-1 pb-3">
        <BodyText className="font-medium">{disclosure.confidenceBasis === "provider_search" ? "Drive search matches" :
          { complete: "Documents ready", partial: "Incomplete documents", unknown: "Unable to verify documents" }[disclosure.coverageStatus]}</BodyText>
        <HelperText>{disclosure.selectedCount} {disclosure.selectedCount === 1 ? "document" : "documents"}{disclosure.confidenceBasis !== "provider_search" ? ` · ${{ complete: "Complete coverage", partial: "Partial coverage", unknown: "Coverage not verified" }[disclosure.coverageStatus]}` : ""}</HelperText>
        {disclosure.periods.length ? <ul aria-label="Document periods" className="space-y-1">
          {disclosure.periods.map((period, index) => <li key={index}><HelperText>{period.start} – {period.end}</HelperText></li>)}
        </ul> : disclosure.confidenceBasis !== "provider_search" ? <HelperText>Date coverage could not be verified.</HelperText> : null}
        {disclosure.limitations.length ? <ul aria-label="Document limitations" className="space-y-1">
          {disclosure.limitations.map((limitation, index) => <li key={index}><BodyText className="[overflow-wrap:anywhere]">{limitation}</BodyText></li>)}
        </ul> : null}
      </section> : payBlocked ? <HelperText role="status">Document details are unavailable. Refresh before paying.</HelperText> : null}
      <PaymentBlock
        payBlocked={payBlocked}
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
