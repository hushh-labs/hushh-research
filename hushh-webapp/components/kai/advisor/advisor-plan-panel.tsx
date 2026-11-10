"use client";

import Link from "next/link";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import styles from "./advisor-review.module.css";

export function AdvisorPlanPanel({
  review,
  context,
  busy,
  run,
}: {
  review: AdvisorReview;
  context: FinanceShareContext;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const advisor = context.userId === review.advisorUserId;
  const introductionComplete = review.meeting?.status === "completed" ||
    review.pastMeetings?.some((meeting) => meeting.status === "completed");
  const [price, setPrice] = useState("");
  const [services, setServices] = useState("");
  const [terms, setTerms] = useState("");
  const [approved, setApproved] = useState(false);
  const [billing, setBilling] = useState<string | null>(null);
  const refresh = () =>
    run(async () => {
      const state = await AdvisorReviewService.billing(context, review.id);
      if (context.isCurrent()) setBilling(state.status);
    });
  const offer = () =>
    run(async () => {
      const cents = Math.round(Number(price) * 100);
      if (!Number.isSafeInteger(cents) || cents < 100 || cents > 100000)
        throw new Error("Choose a monthly price between $1 and $1,000.");
      await AdvisorReviewService.offer(context, review.id, {
        amountCents: cents,
        currency: "usd",
        interval: "month",
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
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
        throw new Error("The secure checkout link could not be verified.");
      if (context.isCurrent()) window.location.assign(url.href);
    });
  return (
    <section className={styles.card}>
      <h3 className="ui-text-section-label">Advisor plan</h3>
      <p className="ui-text-helper-text">Stripe test mode</p>
      <details className="ui-text-helper-text">
        <summary>About the optional plan</summary>
        <p>Test payments use no real money. Plans grant no trading permission or extra portfolio access.</p>
      </details>
      {review.plan ? (
        <div className={styles.stack}>
          <div>
            <p className="ui-text-headline">
              ${(review.plan.amountCents / 100).toFixed(2)} / month
            </p>
            <p>{review.plan.services}</p>
            <p className="ui-text-helper-text">
              {review.plan.cancellationTerms}
            </p>
          </div>
          {!advisor ? (
            <>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  I agree to this monthly price, services and cancellation
                  terms.
                </span>
              </label>
              <ShellActionSurface
                variant="pill"
                className={styles.primary}
                disabled={busy || !approved || billing === "active"}
                onClick={() => void checkout()}
              >
                Continue to test checkout
              </ShellActionSurface>
            </>
          ) : null}
          <div className={styles.actions}>
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Check payment status
            </ShellActionSurface>
            {!advisor &&
            billing &&
            !["not_started", "cancelled"].includes(billing) ? (
              <ShellActionSurface
                variant="pill"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await AdvisorReviewService.cancelBilling(
                      context,
                      review.id,
                    );
                    if (context.isCurrent()) setBilling("cancelled");
                  })
                }
              >
                Cancel subscription or checkout
              </ShellActionSurface>
            ) : null}
          </div>
          {billing ? (
            <p role="status">
              {billing === "active"
                ? "Test subscription active — confirmed by Stripe."
                : `Payment: ${billing.replaceAll("_", " ")}.`}
            </p>
          ) : (
            <p className="ui-text-helper-text">
              Returning from checkout does not confirm payment. Check its
              status.
            </p>
          )}
        </div>
      ) : (
        <p className="ui-text-helper-text">
          {introductionComplete
            ? "The advisor can now offer a monthly plan."
            : "Available after the introduction."}
        </p>
      )}
      {advisor && introductionComplete ? (
        <details>
          <summary className="ui-text-button-label">
            Offer or update a plan
          </summary>
          <form
            className={styles.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void offer();
            }}
          >
            <label className={styles.field}>
              Monthly price (USD)
              <Input
                required
                type="number"
                min="1"
                max="1000"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              Included services
              <Textarea
                required
                minLength={20}
                maxLength={1500}
                value={services}
                onChange={(e) => setServices(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              Cancellation and refund terms
              <Textarea
                required
                minLength={20}
                maxLength={1500}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
              />
            </label>
            <ShellActionSurface type="submit" variant="pill" disabled={busy}>
              Offer test plan
            </ShellActionSurface>
          </form>
        </details>
      ) : null}
      {advisor ? (
        <div className={styles.notice}>
          <p className="ui-text-helper-text">
            Set up payouts to offer a plan.
          </p>
          <Link href="/one/profile/payouts" className="ui-text-button-label">
            Finish Stripe setup
          </Link>
        </div>
      ) : null}
    </section>
  );
}
