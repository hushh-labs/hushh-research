"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { Button } from "@/lib/morphy-ux/button";

/** A browser return is a hint. Only this answer's order confirms payment. */
export function AnswerPaymentReturnNotice({ requestId, checkout }: {
  requestId: string; checkout: string;
}) {
  const { user, userId } = useAuth();
  const [message, setMessage] = useState("Checking payment status…");
  const identity = `${userId ?? ""}:${requestId}`;
  const [checkedIdentity, setCheckedIdentity] = useState(identity);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setMessage("Checking payment status…");
    setCheckedIdentity(identity);
    if (!user) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTransition = "";
    const check = async () => {
      polls++;
      let pending = true;
      try {
        const payment = await AnswerRequestService.payment(await user.getIdToken(), requestId);
        if (!live) return;
        const transition = `${payment.orderStatus}:${payment.requestStatus}:${payment.preparationStatus}`;
        if (transition !== lastTransition) {
          lastTransition = transition;
          dispatchConsentStateChanged({ source: "answer_payment_status", requestId: `answer_request:${requestId}` });
        }
        if (payment.orderStatus === "refunded") {
          setMessage("Your payment was refunded because this question could not be answered.");
          pending = false;
        } else if (payment.orderStatus === "paid" && payment.paidAt) {
          if (payment.reconciliationRequired) {
            setMessage("Payment received. We're checking this request and will update you.");
          } else if (["cancelled", "declined", "expired"].includes(payment.requestStatus)) {
            setMessage("Payment received · Refund pending.");
          } else if (payment.requestStatus === "answered") {
            setMessage("Payment confirmed. Your answer is ready to open in Feed.");
            pending = false;
          } else {
            setMessage("Payment confirmed. Your answer is being prepared.");
          }
        } else if (payment.orderStatus === "expired") {
          setMessage("This payment link expired. Refresh the question before paying.");
          pending = false;
        } else if (["cancel", "cancelled"].includes(checkout)) {
          setMessage("Checkout was cancelled. We'll update this question if payment confirmation arrives.");
        } else {
          setMessage("Payment is processing. We'll update your question when it's confirmed.");
        }
      } catch {
        if (!live) return;
        setMessage("We couldn't check payment yet. Retry to refresh this question.");
      }
      if (live && pending && polls < 40) timer = setTimeout(check, 3000);
    };
    void check();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [user, requestId, checkout, attempt, identity]);
  return <div role="status" aria-live="polite" data-testid="feed-payment-return" className="mx-4 mb-3 rounded-xl bg-accent/[0.06] px-4 py-3 text-sm">
    <p>{checkedIdentity === identity && user ? message : "Checking payment status…"}</p>
    <Button size="standard" variant="none" onClick={() => setAttempt(value => value + 1)}>Refresh question</Button>
  </div>;
}
