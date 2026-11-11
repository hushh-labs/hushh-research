"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import type { AdvisorBilling, AdvisorReview, AdvisorSandboxPayout } from "@/lib/advisor-review/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { documentPayoutLinkUrl } from "@/lib/services/document-payout-links";
import styles from "./advisor-review.module.css";

const payoutStatus = {
  pending: "Pending", in_transit: "On its way", paid: "Paid",
  failed: "Failed", canceled: "Cancelled",
};

export function AdvisorPlanPanel({
  review,
  context,
  busy,
  run,
  active = true,
  refreshPaymentOnOpen = false,
}: {
  review: AdvisorReview;
  context: FinanceShareContext;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  active?: boolean;
  refreshPaymentOnOpen?: boolean;
}) {
  const advisor = context.userId === review.advisorUserId;
  const canStartPlan = review.status === "accepted";
  const [price, setPrice] = useState("");
  const [services, setServices] = useState("");
  const [terms, setTerms] = useState("");
  const [approved, setApproved] = useState(false);
  const [billing, setBilling] = useState<AdvisorBilling | null>(null);
  const [sandbox, setSandbox] = useState<AdvisorSandboxPayout | "unavailable" | null>(null);
  const showPayouts = advisor && canStartPlan;
  const hasPlan = Boolean(review.plan);
  const oneTime = review.plan?.interval === "one_time";
  const revision = review.planRevision;
  const status = billing?.status;
  const canPay = oneTime && !advisor && canStartPlan &&
    status !== undefined && ["not_started", "preparing", "checkout_pending", "expired"].includes(status);
  const canCancel = !advisor && (oneTime
    ? status === "checkout_pending"
    : status !== undefined && !["not_started", "cancelled"].includes(status));
  const payoutReady = sandbox !== "unavailable" && sandbox?.setup === "ready";
  useEffect(() => {
    if (!showPayouts || !active) return;
    const controller = new AbortController();
    void AdvisorReviewService.sandboxPayout(context, review.id, controller.signal).then(
      (value) => { if (!controller.signal.aborted && context.isCurrent()) setSandbox(value); },
      () => { if (!controller.signal.aborted && context.isCurrent()) setSandbox("unavailable"); },
    );
    return () => controller.abort();
  }, [active, context, review.id, showPayouts]);
  useEffect(() => {
    if ((!oneTime && !refreshPaymentOnOpen) || !active || !hasPlan) return;
    const controller = new AbortController();
    void AdvisorReviewService.billing(context, review.id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && context.isCurrent() && (!oneTime || value.planRevision === revision)) {
          setBilling(value);
        }
      },
      () => { /* The manual check remains available for an interrupted return. */ },
    );
    return () => controller.abort();
  }, [active, context, hasPlan, oneTime, refreshPaymentOnOpen, review.id, revision]);
  const openStripe = (action: "onboarding" | "dashboard") => run(async () => {
    const result = await AdvisorReviewService.sandboxPayoutLink(context, review.id, action);
    if (result.mode !== "test") {
      throw new Error("The Stripe sandbox link could not be verified.");
    }
    const url = documentPayoutLinkUrl(result.url, action === "dashboard" ? "management" : "onboarding");
    if (context.isCurrent()) window.location.assign(url);
  });
  const refreshPayout = () => run(async () => {
    const value = await AdvisorReviewService.sandboxPayout(context, review.id);
    if (context.isCurrent()) setSandbox(value);
  });
  const refresh = () =>
    run(async () => {
      const state = await AdvisorReviewService.billing(context, review.id);
      if (oneTime && state.planRevision !== revision) throw new Error("The offer changed. Refresh to see the new price.");
      if (context.isCurrent()) setBilling(state);
    });
  const offer = () =>
    run(async () => {
      const cents = Math.round(Number(price) * 100);
      if (!Number.isSafeInteger(cents) || cents < 100 || cents > 100000)
        throw new Error("Choose a price between $1 and $1,000.");
      await AdvisorReviewService.offer(context, review.id, {
        amountCents: cents,
        currency: "usd",
        interval: "one_time",
        services: services.trim(),
        cancellationTerms: terms.trim(),
      });
    });
  const checkout = () =>
    run(async () => {
      const result = await AdvisorReviewService.checkout(
        context,
        review.id,
        review.planRevision,
      );
      const url = new URL(result.url);
      if (result.mode !== "test" || url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" ||
        url.username || url.password || url.port)
        throw new Error("The secure checkout link could not be verified.");
      if (context.isCurrent()) window.location.assign(url.href);
    });
  return (
    <div className={styles.stack}>
      <section className={`${styles.card} ${styles.planCard}`} aria-label="Advisor plan">
        <div className={styles.row}>
          <h3 className="ui-text-section-label">Advisor plan</h3>
          <span className="ui-text-helper-text">Stripe sandbox</span>
        </div>
        {review.plan ? (
          <>
            <div className={styles.planDetails}>
              <p className="ui-text-row-label">
                ${(review.plan.amountCents / 100).toFixed(2)}{oneTime ? " one-time" : " / month"}
              </p>
              {review.plan.services ? <p>{review.plan.services}</p> : null}
              {review.plan.cancellationTerms ? (
                <p className="ui-text-helper-text">{review.plan.cancellationTerms}</p>
              ) : null}
            </div>
            {canPay ? (
              <label className={styles.planConsent}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(event) => setApproved(event.target.checked)}
                  disabled={busy}
                />
                <span>{review.plan.services || review.plan.cancellationTerms
                  ? "I agree to this one-time payment and the details above."
                  : "I agree to this one-time payment."}</span>
              </label>
            ) : null}
            <div className={styles.planActions}>
              {canPay ? (
                <ShellActionSurface
                  variant="pill"
                  className={styles.handshakePrimary}
                  disabled={busy || !approved}
                  onClick={() => void checkout()}
                >
                  Pay ${(review.plan.amountCents / 100).toFixed(2)}
                </ShellActionSurface>
              ) : null}
              <ShellActionSurface variant="pill" disabled={busy} onClick={() => void refresh()}>
                Check payment status
              </ShellActionSurface>
              {canCancel ? (
                <ShellActionSurface
                  variant="pill"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await AdvisorReviewService.cancelBilling(context, review.id);
                      const next = await AdvisorReviewService.billing(context, review.id);
                      if (context.isCurrent() && (!oneTime || next.planRevision === revision)) setBilling(next);
                    })
                  }
                >
                  {oneTime ? "Cancel checkout" : "Cancel subscription or checkout"}
                </ShellActionSurface>
              ) : null}
            </div>
            {status && status !== "not_started" ? (
              <p role="status">
                {status === "paid" && billing?.paidAt && billing.amountCents
                  ? `Paid $${(billing.amountCents / 100).toFixed(2)} · ${new Date(billing.paidAt).toLocaleDateString()}`
                  : status === "active"
                  ? "Test subscription active"
                  : status === "checkout_pending"
                  ? "Checkout open"
                  : status === "processing"
                  ? "Payment pending"
                  : `Payment status · ${status.replaceAll("_", " ")}`}
              </p>
            ) : null}
            {billing?.lastPayment ? (
              <p className="ui-text-helper-text">
                Previous payment · ${(billing.lastPayment.amountCents / 100).toFixed(2)} · {new Date(billing.lastPayment.paidAt).toLocaleDateString()}
                {billing.lastPayment.status !== "paid" ? ` · ${billing.lastPayment.status.replaceAll("_", " ")}` : ""}
              </p>
            ) : null}
          </>
        ) : (
          <p className="ui-text-helper-text">
            {!advisor ? "Waiting for the advisor’s offer."
              : payoutReady ? "Set a price and describe what’s included."
              : "Set up test payouts to offer a plan."}
          </p>
        )}
        {advisor && canStartPlan && payoutReady ? (
          <details>
            <summary className="ui-text-button-label">Offer or update a plan</summary>
            <form className={styles.stack} onSubmit={(event) => {
              event.preventDefault();
              void offer();
            }}>
              <label className={styles.field}>
                One-time price (USD)
                <Input required type="number" min="1" max="1000" step="0.01"
                  value={price} onChange={(event) => setPrice(event.target.value)} />
              </label>
              <label className={styles.field}>
                Included services (optional)
                <Textarea maxLength={1500}
                  value={services} onChange={(event) => setServices(event.target.value)} />
              </label>
              <label className={styles.field}>
                Cancellation and refund terms (optional)
                <Textarea maxLength={1500}
                  value={terms} onChange={(event) => setTerms(event.target.value)} />
              </label>
              <ShellActionSurface type="submit" variant="pill" disabled={busy}>
                Offer test plan
              </ShellActionSurface>
            </form>
          </details>
        ) : null}
        {!advisor ? (
          <p className="ui-text-helper-text">
            Test payments use no real money. A plan grants no trading or extra portfolio access.
          </p>
        ) : null}
      </section>
      {showPayouts ? (
        <section className={`${styles.card} ${styles.planCard}`} aria-label="Sandbox payouts">
          <h3 className="ui-text-section-label">Test payouts</h3>
          {sandbox === null ? <p role="status" className="ui-text-helper-text">Checking Stripe…</p>
            : sandbox === "unavailable" ? <p className="ui-text-helper-text">Sandbox status is unavailable.</p>
            : payoutReady ? (
              <div className={styles.planDetails}>
                <p className="ui-text-row-label">Test bank account ready</p>
                <p className="ui-text-helper-text">
                  {sandbox.latest
                    ? `Latest account payout · ${payoutStatus[sandbox.latest.status]} · $${(sandbox.latest.amountCents / 100).toFixed(2)}`
                    : "No sandbox payouts yet."}
                </p>
              </div>
            ) : <p className="ui-text-helper-text">Finish sandbox setup to receive test payouts.</p>}
          {sandbox !== null ? (
            <div className={styles.planActions}>
              {sandbox !== "unavailable" ? (
                <ShellActionSurface
                  variant="pill"
                  className={!payoutReady ? styles.handshakePrimary : undefined}
                  disabled={busy}
                  onClick={() => void openStripe(payoutReady ? "dashboard" : "onboarding")}
                >
                  {payoutReady ? "Open test Stripe" : "Set up test payouts"}
                </ShellActionSurface>
              ) : null}
              <ShellActionSurface variant="pill" disabled={busy} onClick={() => void refreshPayout()}>
                Check payout status
              </ShellActionSurface>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
