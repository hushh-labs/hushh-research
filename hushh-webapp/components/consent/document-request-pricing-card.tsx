"use client";

import { useId } from "react";
import { useDocumentRequestPricingModel } from "./use-document-request-pricing-model";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ProfileAccountPriceIcon, ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { FormLabel, HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { Button } from "@/lib/morphy-ux/button";

/** Future-request default; an existing quote keeps its agreed price. */
export function DocumentRequestPricingCard({ onSaved, model }: {
  /**
   * Runs once per confirmed default price, after the consent-state dispatch.
   * "Ask each time" leaves waiting requests unpriced, so the owner stays here.
   */
  onSaved?: () => void;
  model?: ReturnType<typeof useDocumentRequestPricingModel>;
}) {
  return model ? <RequestPricingForm model={model} /> : <OwnedRequestPricingForm onSaved={onSaved} />;
}

function OwnedRequestPricingForm({ onSaved }: { onSaved?: () => void }) {
  const model = useDocumentRequestPricingModel({ onSaved });
  return <RequestPricingForm model={model} />;
}

function RequestPricingForm({ model }: { model: ReturnType<typeof useDocumentRequestPricingModel> }) {
  const priceId = useId();
  const { available, saved, dollars, loading, saving, error, notice, amountCents, dirty, save, change, retry } = model;
  if (!available) return null;

  return (
    <section aria-label="Request pricing" className="consent-presentation-surface space-y-3">
      <SettingsGroup title="Google Drive" density="compact" separatorInset={false} contentClassName="divide-y-0">
        <SettingsRow icon={ProfileAccountPriceIcon} iconTone="capability"
          className="!min-h-0 [&>.grid]:!min-h-0 [&>.grid]:py-1"
          title="Price per request"
          description={loading ? "Loading price…" : saved?.enabled
            ? `${formatDocumentRequestPrice(saved.amountCents)} per request`
            : saved ? "Ask each time" : "Price unavailable"} />
        {saved ? (
          <form className="space-y-2 px-3 pb-2" onSubmit={(event) => { event.preventDefault(); void save(true); }}>
            <div className="space-y-[var(--app-form-field-gap)]">
              <FormLabel as="label" htmlFor={priceId}>Default price (USD)</FormLabel>
              <Input data-consent-input="true" id={priceId} type="text" inputMode="decimal" value={dollars}
                placeholder="Amount" onChange={(event) => change(event.target.value)}
                disabled={saving} aria-invalid={dollars !== "" && amountCents === null}
                aria-describedby={`${priceId}-help`} />
              <HelperText id={`${priceId}-help`}>$0.50–$500, including cents.</HelperText>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button data-consent-role="compact-action" type="submit" size="sm" effect="fade" disabled={!dirty || amountCents === null || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved.enabled ? (
                <Button data-consent-quiet-action="true" data-consent-role="compact-action" type="button" size="sm" effect="fade" variant="none" disabled={saving} onClick={() => void save(false)}>
                  Ask each time
                </Button>
              ) : null}
            </div>
          </form>
        ) : !loading ? (
          <SettingsRow title="Retry" iconTone="capability" onClick={retry} />
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
