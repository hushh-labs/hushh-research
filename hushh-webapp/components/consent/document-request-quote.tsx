"use client";

import { useCallback, useEffect, useState } from "react";

import { HelperText } from "@/components/app-ui/typography";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { Button } from "@/lib/morphy-ux/button";
import {
  DriveRequestPricingService,
  type DriveRequestQuote,
} from "@/lib/services/drive-request-pricing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** A displayed quote is required before creating a document request. */
export function useDocumentRequestQuote({
  active,
  ownerPersonRef,
  getToken,
}: {
  active: boolean;
  ownerPersonRef: string;
  getToken: () => string | null;
}) {
  const [quote, setQuote] = useState<DriveRequestQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => {
    setQuote(null);
    setReload((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      setQuote(null);
      setError(null);
      return;
    }
    const token = getToken();
    const epoch = snapshotVaultSessionEpoch();
    if (!token) {
      setQuote(null);
      setError("Unlock your vault to check this price.");
      return;
    }
    let cancelled = false;
    setQuote(null);
    setLoading(true);
    setError(null);
    void DriveRequestPricingService.quote(token, ownerPersonRef)
      .then((next) => {
        if (!cancelled && isVaultSessionEpochCurrent(epoch) && getToken() === token) {
          setQuote(next);
        }
      })
      .catch(() => {
        if (!cancelled && isVaultSessionEpochCurrent(epoch) && getToken() === token) {
          setError("Couldn't check the request price. Try again.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, ownerPersonRef, getToken, reload]);

  return { quote, loading, error, refresh };
}

export function DocumentRequestQuoteNotice({
  quote,
  loading,
  error,
  onRetry,
}: {
  quote: DriveRequestQuote | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) return <HelperText role="status">Checking request price…</HelperText>;
  if (error) return (
    <div className="space-y-1">
      <HelperText role="alert">{error}</HelperText>
      <Button type="button" size="standard" variant="none" onClick={onRetry}>Retry price check</Button>
    </div>
  );
  if (!quote) return null;
  return (
    <div className="space-y-1" aria-label="Document request quote">
      <HelperText>{!quote.paymentRequired
        ? "No payment is required for this request."
        : quote.priceReady && quote.amountCents !== null
          ? `Price: ${formatDocumentRequestPrice(quote.amountCents)}. Pay only if files are found.`
          : "The owner will set a price. You review it before paying."}</HelperText>
      {quote.paymentRequired && !quote.payoutReady ? (
        <HelperText>We'll ask the owner to set up payouts.</HelperText>
      ) : quote.paymentRequired && !quote.paymentsReady ? (
        <HelperText>Payments are unavailable. You can still send your request.</HelperText>
      ) : null}
    </div>
  );
}
