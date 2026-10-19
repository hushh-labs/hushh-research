"use client";

import { useEffect, useRef, useState } from "react";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { formatDocumentRequestPrice, parseDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { apiErrorCode } from "@/lib/services/api-client";
import { DriveRequestPricingService, type DriveRequestPricing } from "@/lib/services/drive-request-pricing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

/** One pricing owner for web and native. Both adapters retain the same cents
 * validation, optimistic version, conflict recovery and confirmed-save callback. */
export function useDocumentRequestPricingModel({ enabled = true, onSaved }: { enabled?: boolean; onSaved?: () => void } = {}) {
  const vault = useVault();
  const vaultOwnerToken = enabled ? vault.vaultOwnerToken : null;
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

  // New requests take cents from $0.50; older whole-dollar requests keep their own rule.
  const amountCents = parseDocumentRequestPrice(dollars);
  const dirty = saved && (!saved.enabled || amountCents !== saved.amountCents);
  const save = async (enabled: boolean) => {
    const targetAmountCents = enabled ? amountCents : saved?.amountCents ?? null;
    if (!vaultOwnerToken || !saved || targetAmountCents === null || inFlight.current ||
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
      if (next.enabled) onSaved?.();
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

  return { available: !!vaultOwnerToken, saved, dollars, loading, saving, error, notice, amountCents, dirty, save,
    change: (value: string) => { setDollars(value); setNotice(null); },
    retry: () => setReload(value => value + 1) };
}
