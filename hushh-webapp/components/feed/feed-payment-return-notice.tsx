"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import {
  formatPaymentMoney,
  parseRequesterPaymentView,
  type RequesterPaymentView,
} from "@/lib/consent/document-request-payment-view";
import { DriveRequestPaymentService } from "@/lib/services/drive-request-payment-service";
import { AnswerPaymentReturnNotice } from "@/components/feed/answer-payment-return-notice";

type ReturnState =
  | "checking"
  | "processing"
  | "paid"
  | "reconciling"
  | "refund_pending"
  | "refunded"
  | "expired"
  | "closed"
  | "cancelled"
  | "unavailable";

/** A payment that won the race with a closed request is refunded, never "confirmed". */
function refundPendingCopy(view: RequesterPaymentView): string {
  const refund = view.refund ? `Refund of ${formatPaymentMoney(view.refund.amountCents)} pending` : "Refund pending";
  return `${view.withdrawn ? "Payment received after you withdrew" : "Payment received"} · ${refund}`;
}

/** Stripe's browser return is only a hint; the server's payment state decides the copy. */
export function FeedPaymentReturnNotice() {
  const { user } = useAuth();
  const [request, setRequest] = useState<{ id: string; checkout: string; answer: boolean } | null>(null);
  const [state, setState] = useState<ReturnState>("checking");
  const [refundCopy, setRefundCopy] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const answerId = params.get("answerPaymentRequestId");
    const id = answerId ?? params.get("paymentRequestId") ?? "";
    if (DOCUMENT_REQUEST_UUID.test(id)) {
      const checkout = params.get("checkout") ?? "";
      // Historical answer sessions returned paid/cancelled; Drive emits success/cancel.
      setRequest({ id, checkout, answer: Boolean(answerId) || checkout === "paid" || checkout === "cancelled" });
    }
  }, []);

  useEffect(() => {
    if (!request || !user || request.answer) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      polls += 1;
      try {
        const token = await user.getIdToken();
        const payment = await DriveRequestPaymentService.status(token, request.id);
        if (!live) return;
        // A current server adds the shared payment view to the legacy status.
        const view = parseRequesterPaymentView(
          (payment as unknown as Record<string, unknown>).paymentView,
        );
        if (view?.state === "refund_pending") {
          setRefundCopy(refundPendingCopy(view));
          setState("refund_pending");
          dispatchConsentStateChanged({ source: "drive_payment_refund_pending" });
          return;
        }
        if (payment.status === "paid") {
          setState(payment.reconciliationRequired ? "reconciling" : "paid");
          dispatchConsentStateChanged({ source: "drive_payment_confirmed" });
          return;
        }
        if (payment.status === "refunded") {
          setState("refunded");
          dispatchConsentStateChanged({ source: "drive_payment_refunded" });
          return;
        }
        // A withdrawn or declined request has no payment window to explain,
        // but a payment that is still settling must not be called "not taken".
        if (view?.state === "closed" && request.checkout !== "success") {
          setState("closed");
          return;
        }
        if (payment.status === "expired" && view?.state !== "closed") {
          setState("expired");
          dispatchConsentStateChanged({ source: "drive_payment_expired" });
          return;
        }
        if (request.checkout === "cancel") {
          setState("cancelled");
          return;
        }
        setState("processing");
      } catch {
        if (!live) return;
        setState("unavailable");
      }
      // A delayed webhook can settle after Checkout redirects. Bound polling;
      // later changes still arrive through the Feed notification channel.
      if (live && request.checkout === "success" && polls < 40) {
        timer = setTimeout(check, 3000);
      }
    };
    void check();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [request, user]);

  if (!request) return null;
  if (request.answer) return <AnswerPaymentReturnNotice requestId={request.id} checkout={request.checkout} />;
  const message = state === "paid"
    ? "Payment confirmed. Sharing will continue shortly."
    : state === "reconciling"
      ? "Payment received. We're checking this request and will update you."
      : state === "refund_pending"
        ? refundCopy ?? "Payment received · Refund pending"
        : state === "refunded"
          ? "Your payment was refunded because this request could not be completed."
          : state === "expired"
            ? "This payment link expired. Send a new document request if you still need the files."
            : state === "closed"
              ? "This request is closed. Nothing to pay."
              : state === "cancelled"
                ? "Payment wasn't completed. Your request is still waiting for payment."
                : state === "unavailable"
                  ? "We couldn't check payment yet. Your request will update when confirmation arrives."
                  : state === "processing"
                    ? "Payment is processing. We'll update your request when it's confirmed."
                    : "Checking payment status…";
  return (
    <div data-profile-role="description" role="status" aria-live="polite" data-testid="feed-payment-return" className="mx-4 mb-3 rounded-xl bg-accent/[0.06] px-4 py-3 text-sm">
      {message}
    </div>
  );
}
