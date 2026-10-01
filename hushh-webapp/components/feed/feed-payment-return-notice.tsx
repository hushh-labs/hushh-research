"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { DriveRequestPaymentService } from "@/lib/services/drive-request-payment-service";

type ReturnState = "checking" | "processing" | "paid" | "reconciling" | "refunded" | "cancelled" | "unavailable";

/** Stripe's browser return is only a hint; the server's payment state decides the copy. */
export function FeedPaymentReturnNotice() {
  const { user } = useAuth();
  const [request, setRequest] = useState<{ id: string; checkout: string } | null>(null);
  const [state, setState] = useState<ReturnState>("checking");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("paymentRequestId") ?? "";
    if (DOCUMENT_REQUEST_UUID.test(id)) {
      setRequest({ id, checkout: params.get("checkout") ?? "" });
    }
  }, []);

  useEffect(() => {
    if (!request || !user) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      polls += 1;
      try {
        const token = await user.getIdToken();
        const payment = await DriveRequestPaymentService.status(token, request.id);
        if (!live) return;
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
  const message = state === "paid"
    ? "Payment confirmed. Sharing will continue shortly."
    : state === "reconciling"
      ? "Payment received. We're checking this request and will update you."
      : state === "refunded"
        ? "Your payment was refunded because this request could not be completed."
    : state === "cancelled"
      ? "Payment wasn't completed. Your request is still waiting for payment."
      : state === "unavailable"
        ? "We couldn't check payment yet. Your request will update when confirmation arrives."
        : state === "processing"
          ? "Payment is processing. We'll update your request when it's confirmed."
          : "Checking payment status…";
  return (
    <div role="status" aria-live="polite" data-testid="feed-payment-return" className="mx-4 mb-3 rounded-xl bg-accent/[0.06] px-4 py-3 text-sm">
      {message}
    </div>
  );
}
