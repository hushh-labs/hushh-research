"use client";

import { useEffect, useId, useRef, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ProfileAccountPriceIcon, ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { FormLabel, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { formatDocumentRequestPrice, parseWholeDollarPrice } from "@/lib/consent/document-request-price";
import { Button } from "@/lib/morphy-ux/button";
import { apiErrorCode } from "@/lib/services/api-client";
import {
  DriveRequestPricingService,
  type DriveRequestPricing,
} from "@/lib/services/drive-request-pricing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

/** Future-request default; an existing quote keeps its agreed price. */
export function DocumentRequestPricingCard() {
  const { vaultOwnerToken } = useVault();
  const priceId = useId();
  const session = useRef(0);
  const inFlight = useRef(false);
  const [saved, setSaved] = useState<DriveRequestPricing | null>(null);
  const [dollars, setDollars] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const operation = ++session.current;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => session.current === operation && isVaultSessionEpochCurrent(epoch);
    inFlight.current = false;
    setSaved(null);
    setDollars("");
    setSaving(false);
    setError(null);
    setNotice(null);
    setLoading(Boolean(vaultOwnerToken));
    if (vaultOwnerToken) {
      void DriveRequestPricingService.owner(vaultOwnerToken)
        .then((next) => {
          if (!current()) return;
          setSaved(next);
          setDollars(next.enabled ? String(next.amountCents / 100) : "");
        })
        .catch(() => {
          if (current()) setError("Couldn't load your price. Try again.");
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    }
    return () => { session.current = operation + 1; };
  }, [vaultOwnerToken, reload]);

  if (!vaultOwnerToken) return null;
  const amountCents = parseWholeDollarPrice(dollars);
  const dirty = saved && (!saved.enabled || amountCents !== saved.amountCents);
  const save = async (enabled: boolean) => {
    const targetAmountCents = enabled ? amountCents : saved?.amountCents ?? null;
    if (!saved || targetAmountCents === null || inFlight.current ||
        (enabled ? !dirty : !saved.enabled)) return;
    const operation = session.current;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => session.current === operation && isVaultSessionEpochCurrent(epoch);
    inFlight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await DriveRequestPricingService.save(vaultOwnerToken, {
        enabled,
        amountCents: targetAmountCents,
        expectedVersion: saved.version,
      });
      if (!current()) return;
      setSaved(next);
      setDollars(next.enabled ? String(next.amountCents / 100) : "");
      setNotice(next.enabled ? "Default price saved." : "You'll set a price for each request.");
      dispatchConsentStateChanged({ source: "document_request_pricing" });
    } catch (cause) {
      if (!current()) return;
      if (apiErrorCode(cause) === "price_changed") {
        try {
          const next = await DriveRequestPricingService.owner(vaultOwnerToken);
          if (!current()) return;
          setSaved(next);
          const currentPrice = next.enabled ? formatDocumentRequestPrice(next.amountCents) : "Ask each time";
          // Keep the owner's draft; updating the version is not permission to save it.
          setError(`Changed elsewhere to ${currentPrice}. Review your amount and save again.`);
        } catch {
          if (current()) setError("Couldn't refresh your price. Try again.");
        }
      } else {
        setError("Couldn't save your price. Try again.");
      }
    } finally {
      if (current()) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <section aria-label="Request pricing" className="space-y-3">
      <SettingsGroup title="Google Drive" density="compact">
        <SettingsRow icon={ProfileAccountPriceIcon} iconTone="capability"
          title="Price per request"
          description={loading ? "Loading price…" : saved?.enabled
            ? `${formatDocumentRequestPrice(saved.amountCents)} per request`
            : saved ? "Ask each time" : "Price unavailable"} />
        {saved ? (
          <form className="space-y-3 px-3 pb-3" onSubmit={(event) => { event.preventDefault(); void save(true); }}>
            <div className="space-y-[var(--app-form-field-gap)]">
              <FormLabel as="label" htmlFor={priceId}>Default price (USD)</FormLabel>
              <Input id={priceId} type="text" inputMode="numeric" value={dollars}
                placeholder="Amount" onChange={(event) => { setDollars(event.target.value); setNotice(null); }}
                disabled={saving} aria-invalid={dollars !== "" && amountCents === null}
                aria-describedby={`${priceId}-help`} />
              <HelperText id={`${priceId}-help`}>Whole dollars, $1–$500.</HelperText>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" effect="fade" disabled={!dirty || amountCents === null || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved.enabled ? (
                <Button type="button" size="sm" effect="fade" variant="none" disabled={saving} onClick={() => void save(false)}>
                  Ask each time
                </Button>
              ) : null}
            </div>
          </form>
        ) : !loading ? (
          <SettingsRow title="Retry" iconTone="capability" onClick={() => setReload((value) => value + 1)} />
        ) : null}
      </SettingsGroup>
      {saved ? <HelperText className="profile-account-note">{saved.enabled
        ? "Trusted requests use this price automatically. Other requests need your approval."
        : "Set each request's price in Feed."}</HelperText> : null}
      <SettingsGroup title="Fees" density="compact">
        <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="From your earnings"
          description="3% Hushh fee + Stripe fees." />
      </SettingsGroup>
      {error ? <HelperText role="alert" className="profile-account-note">{error}</HelperText> : null}
      {notice ? <HelperText role="status" className="profile-account-note">{notice}</HelperText> : null}
    </section>
  );
}
