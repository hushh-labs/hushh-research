"use client";

import { useCallback, useId, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { type EmailFrequency } from "@/lib/services/marketing-preference-service";
import type { useMarketingPreference } from "./use-marketing-preference";

type EmailPreferenceModel = ReturnType<typeof useMarketingPreference>;

function EmailFrequencySelect({ model }: { model: EmailPreferenceModel }) {
  const frequencyId = useId();
  const [frequencyMenu, setFrequencyMenu] = useState<{
    pathname: string; query: Record<string, string>;
  } | null>(null);
  const setFrequencyOpen = useCallback((open: boolean) => {
    setFrequencyMenu(open ? {
      pathname: window.location.pathname,
      query: Object.fromEntries(new URLSearchParams(window.location.search)),
    } : null);
  }, []);
  useBackLayer(frequencyMenu?.pathname ?? "", frequencyMenu ? 100 : 0, () => {
    if (!frequencyMenu) return false;
    setFrequencyMenu(null);
    return true;
  }, frequencyMenu?.query);
  const enabled = model.enabledDraft, frequency = model.frequencyDraft;
  return <div className="space-y-2">
    <label htmlFor={frequencyId} className="block text-sm">Email frequency</label>
    <Select value={frequency} disabled={model.busy} open={frequencyMenu !== null} onOpenChange={setFrequencyOpen} onValueChange={(value) => model.edit(enabled, value as EmailFrequency)}>
      <SelectTrigger id={frequencyId} data-voice-control-id="one_email_updates_frequency" className="min-h-11 w-full border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" position="popper" className="rounded-[14px]">
        <SelectItem value="weekly" className="min-h-11 py-2.5">Weekly digest</SelectItem>
        <SelectItem value="daily" className="min-h-11 py-2.5">Daily tips</SelectItem>
        <SelectItem value="updates" className="min-h-11 py-2.5">Product updates only</SelectItem>
      </SelectContent>
    </Select>
  </div>;
}

export function MarketingPreferencePanel({ model }: { model: EmailPreferenceModel }) {
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
      <EmailFrequencySelect model={model} />
      <Button data-voice-control-id="one_email_updates_save" type="submit" variant="outline" disabled={model.busy || enabled === model.value.enabled && frequency === model.value.frequency}>
        {model.busy ? "Saving…" : "Save email preference"}
      </Button>
      {model.saved ? <p role="status" className="text-sm">Email preference saved.</p> : null}
    </form> : !model.loading ? <Button data-voice-control-id="one_email_updates_retry" type="button" variant="outline" onClick={() => void model.refresh()}>Retry email preference</Button> : null}
  </section>;
}
