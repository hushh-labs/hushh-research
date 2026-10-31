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
          setError("Couldn't check the price.");
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
  personName,
}: {
  quote: DriveRequestQuote | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Who sets the price when there is no estimate yet. */
  personName?: string;
}) {
  if (loading) return <HelperText role="status">Checking price…</HelperText>;
  if (error) return (
    <div className="space-y-1">
      <HelperText role="alert">{error}</HelperText>
      <Button data-consent-quiet-action="true" data-consent-role="compact-action" type="button" size="standard" variant="none" onClick={onRetry}>Retry</Button>
    </div>
  );
  if (!quote) return null;
  // The name starts the sentence, so a fallback like "this person" needs its capital.
  const setter = personName ? personName.charAt(0).toUpperCase() + personName.slice(1) : "The owner";
  return (
    <div className="space-y-1" aria-label="Document request quote">
      {/* True for every requester, Trusted or not: the owner may still set the
          price, which is shown before any payment. */}
      <HelperText>{!quote.paymentRequired
        ? "No payment needed."
        : quote.priceReady && quote.amountCents !== null
          ? `About ${formatDocumentRequestPrice(quote.amountCents)}. You pay only if files are found.`
          : `${setter} sets the price. You see it before you pay.`}</HelperText>
      {quote.paymentRequired && !quote.payoutReady ? (
        <HelperText>We'll ask the owner to set up payouts.</HelperText>
      ) : quote.paymentRequired && !quote.paymentsReady ? (
        <HelperText>Payments are unavailable. You can still send your request.</HelperText>
      ) : null}
    </div>
  );
}
