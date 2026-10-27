"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { Clock3, Mail } from "lucide-react";
import { useEffect, useRef } from "react";
import { type EmailFrequency } from "@/lib/services/marketing-preference-service";
import type { useMarketingPreference } from "./use-marketing-preference";

type PreferenceModel = ReturnType<typeof useMarketingPreference>;

export function MarketingPreferencePanel({ model, variant = "setup" }: {
  model: PreferenceModel;
  variant?: "setup" | "account";
}) {
  if (variant === "account") return <AccountEmailPreference model={model} />;
  const enabled = model.enabledDraft, frequency = model.frequencyDraft;
  return <section aria-label="Optional One email updates" className="rounded-xl border p-4 text-left space-y-3">
    <h2 className="text-sm font-medium">One email updates (optional)</h2>
    <p className="text-sm text-muted-foreground">Useful tips, demos and product news by email. You can unsubscribe anytime.</p>
    {model.loading ? <p role="status" className="text-sm">Loading saved preference…</p> : null}
    {model.error ? <p role="alert" className="text-sm">{model.error}</p> : null}
    {model.value ? <form onSubmit={(event) => { event.preventDefault(); void model.save(enabled, frequency); }} className="space-y-3">
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
        Email me One tips and product updates
        <Switch data-voice-control-id="one_email_updates_enabled" checked={enabled} disabled={model.busy} onCheckedChange={(value) => model.edit(value, frequency)} aria-label="Email me One tips and product updates" />
      </label>
      <label className="block text-sm">Email frequency
        <select data-voice-control-id="one_email_updates_frequency" value={frequency} disabled={model.busy} onChange={(event) => model.edit(enabled, event.target.value as EmailFrequency)} className="mt-2 block min-h-11 w-full rounded-[var(--app-input-radius)] border bg-background px-3">
          <option value="weekly">Weekly digest</option><option value="daily">Daily tips</option><option value="updates">Product updates only</option>
        </select>
      </label>
      <Button data-voice-control-id="one_email_updates_save" type="submit" variant="outline" disabled={model.busy || enabled === model.value.enabled && frequency === model.value.frequency}>
        {model.busy ? "Saving…" : "Save email preference"}
      </Button>
      {model.saved ? <p role="status" className="text-sm">Email preference saved.</p> : null}
    </form> : !model.loading ? <Button data-voice-control-id="one_email_updates_retry" type="button" variant="outline" onClick={() => void model.refresh()}>Retry email preference</Button> : null}
  </section>;
}

function AccountEmailPreference({ model }: { model: PreferenceModel }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash === "#email-updates") section.current?.scrollIntoView({ block: "start" });
  }, []);
  const enabled = model.enabledDraft, frequency = model.frequencyDraft;
  return <section id="email-updates" ref={section} aria-label="Optional One email updates" className="scroll-mt-4">
    <form onSubmit={(event) => { event.preventDefault(); void model.save(enabled, frequency); }}>
      <SettingsGroup title="Email updates" description="Optional tips, demos and product news. Unsubscribe anytime." density="compact">
        {model.loading ? <p role="status" className="px-4 py-3 text-sm text-muted-foreground">Loading saved preference…</p> : null}
        {model.error ? <p role="alert" className="px-4 py-3 text-sm">{model.error}</p> : null}
        {model.value ? <>
          <SettingsRow icon={Mail} iconTone="capability" title="One tips and product updates" trailingInteractive trailing={
            <Switch data-voice-control-id="one_email_updates_enabled" checked={enabled} disabled={model.busy}
              onCheckedChange={(value) => model.edit(value, frequency)} aria-label="Email me One tips and product updates" />
          } />
          <SettingsRow icon={Clock3} title="Frequency" trailingInteractive stackTrailingOnMobile className="[--settings-row-stack-indent:0px]" trailing={
            <select aria-label="Email frequency" data-voice-control-id="one_email_updates_frequency" value={frequency} disabled={model.busy}
              onChange={(event) => model.edit(enabled, event.target.value as EmailFrequency)}
              className="min-h-11 w-full rounded-[var(--app-input-radius)] border bg-background px-3 text-sm sm:w-auto">
              <option value="weekly">Weekly digest</option><option value="daily">Daily tips</option><option value="updates">Product updates only</option>
            </select>
          } />
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p role="status" className="text-xs text-muted-foreground">{model.saved ? "Email preference saved." : "Changes apply when you save."}</p>
            <Button data-voice-control-id="one_email_updates_save" type="submit" size="sm" variant="outline"
              disabled={model.busy || enabled === model.value.enabled && frequency === model.value.frequency}>
              {model.busy ? "Saving…" : "Save email preference"}
            </Button>
          </div>
        </> : !model.loading ? <div className="px-4 py-3"><Button data-voice-control-id="one_email_updates_retry" type="button" size="sm" variant="outline"
          onClick={() => void model.refresh()}>Retry email preference</Button></div> : null}
      </SettingsGroup>
    </form>
  </section>;
}
