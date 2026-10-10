"use client";

import { useEffect, useId, useState } from "react";

import { HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDocumentRequestPrice, parseWholeDollarPrice } from "@/lib/consent/document-request-price";
import { Button } from "@/lib/morphy-ux/button";
import { apiErrorCode } from "@/lib/services/api-client";
import {
  DriveRequestPricingService,
  type DriveRequestPricing,
} from "@/lib/services/drive-request-pricing-service";
import { useVault } from "@/lib/vault/vault-context";

/** Future-request price; a request already sent keeps its original quote. */
export function DocumentRequestPricingCard() {
  const { vaultOwnerToken } = useVault();
  const priceId = useId();
  const switchId = useId();
  const [saved, setSaved] = useState<DriveRequestPricing | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [dollars, setDollars] = useState("10");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultOwnerToken) {
      setSaved(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setSaved(null);
    setLoading(true);
    setError(null);
    void DriveRequestPricingService.owner(vaultOwnerToken)
      .then((next) => {
        if (cancelled) return;
        setSaved(next);
        setEnabled(next.enabled);
        setDollars(String(next.amountCents / 100));
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load Drive pricing. Try again later.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [vaultOwnerToken]);

  if (!vaultOwnerToken) return null;
  const amountCents = parseWholeDollarPrice(dollars);
  const targetAmountCents = enabled ? amountCents : saved?.amountCents ?? null;
  const dirty = saved && (enabled !== saved.enabled ||
    (enabled && amountCents !== saved.amountCents));
  const save = async () => {
    if (!vaultOwnerToken || !saved || !targetAmountCents || !dirty || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await DriveRequestPricingService.save(vaultOwnerToken, {
        enabled,
        amountCents: targetAmountCents,
        expectedVersion: saved.version,
      });
      setSaved(next);
      setEnabled(next.enabled);
      setDollars(String(next.amountCents / 100));
      setNotice("Saved for future document requests. Existing quotes stay the same.");
    } catch (cause) {
      if (apiErrorCode(cause) === "price_changed") {
        try {
          const next = await DriveRequestPricingService.owner(vaultOwnerToken);
          setSaved(next);
          setEnabled(next.enabled);
          setDollars(String(next.amountCents / 100));
          setError("Your price changed elsewhere. Review it before saving again.");
        } catch {
          setError("Couldn't refresh Drive pricing. Try again later.");
        }
      } else {
        setError("Couldn't save Drive pricing. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Google Drive request price" className="rounded-2xl border border-border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Google Drive request price</p>
          <HelperText className="mt-1">One price per request. Requesters see the quote before sending and pay only if matching files are ready.</HelperText>
        </div>
        {saved ? <Switch id={switchId} checked={enabled} disabled={saving} onCheckedChange={setEnabled} aria-label="Use my Drive request price" /> : null}
      </div>
      {loading ? <HelperText role="status" className="mt-3">Loading Drive price…</HelperText> : null}
      {saved ? (
        <div className="mt-4 space-y-3">
          <label htmlFor={switchId} className="text-sm font-medium">{enabled ? "Use my price" : "Use the $10 default"}</label>
          {enabled ? (
            <div className="space-y-1">
              <label htmlFor={priceId} className="text-sm font-medium">Price in US dollars</label>
              <Input id={priceId} type="text" inputMode="numeric" value={dollars}
                onChange={(event) => setDollars(event.target.value)} disabled={saving}
                aria-invalid={amountCents === null} />
              <HelperText>Whole dollars from $1 to $500.</HelperText>
            </div>
          ) : <HelperText>Requests use the platform price of {formatDocumentRequestPrice(1000)}. Turn this on to set your own price.</HelperText>}
          <Button type="button" size="standard" disabled={!dirty || (enabled && amountCents === null) || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save request price"}
          </Button>
        </div>
      ) : null}
      {error ? <HelperText role="alert" className="mt-2">{error}</HelperText> : null}
      {notice ? <HelperText role="status" className="mt-2">{notice}</HelperText> : null}
    </section>
  );
}
