"use client";

import { useCallback, useId, useState } from "react";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { Timer } from "@/components/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { type EmailFrequency } from "@/lib/services/marketing-preference-service";
import type { useMarketingPreference } from "./use-marketing-preference";

type EmailPreferenceModel = ReturnType<typeof useMarketingPreference>;

export const EMAIL_UPDATES_DESCRIPTION = "Tips, demos and news. Unsubscribe anytime.";

function EmailFrequencySelect({ model }: { model: EmailPreferenceModel }) {
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
  return (
    <SettingsRow
      icon={Timer}
      iconTone="capability"
      title={
        <Select value={frequency} disabled={model.busy} open={frequencyMenu !== null} onOpenChange={setFrequencyOpen} onValueChange={(value) => model.edit(enabled, value as EmailFrequency)}>
          <SelectTrigger aria-label="Email frequency" data-voice-control-id="one_email_updates_frequency" className="min-h-11 w-full border-0 bg-transparent px-0 text-inherit shadow-none dark:bg-transparent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" position="popper">
            <SelectItem value="weekly" className="min-h-11 py-2.5">Weekly digest</SelectItem>
            <SelectItem value="daily" className="min-h-11 py-2.5">Daily tips</SelectItem>
            <SelectItem value="updates" className="min-h-11 py-2.5">Product updates only</SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}

export function MarketingPreferencePanel({ model }: { model: EmailPreferenceModel }) {
  const descriptionId = useId();
  return (
    <form aria-label="Email updates" onSubmit={(event) => {
      event.preventDefault();
      if (model.hasChanges) void model.save(model.enabledDraft, model.frequencyToSave);
    }}>
      <SettingsRow
        icon={PROFILE_ICONS.mail}
        iconTone="capability"
        title="Email updates"
        description={<>
          <span id={descriptionId}>{EMAIL_UPDATES_DESCRIPTION}</span>
          {model.loading ? <span role="status" className="block">Loading preference…</span> : null}
          {model.error ? <span role="alert" className="block">{model.error}</span> : null}
        </>}
        trailing={model.value ? (
          <Switch
            size="ios"
            className="relative after:absolute after:inset-x-0 after:-inset-y-2"
            data-voice-control-id="one_email_updates_enabled"
            aria-label="Email updates"
            aria-describedby={descriptionId}
            checked={model.enabledDraft}
            disabled={model.busy}
            onCheckedChange={(value) => model.edit(value, model.frequencyDraft)}
          />
        ) : !model.loading ? (
          <Button data-voice-control-id="one_email_updates_retry" type="button" variant="link" className="min-h-11 px-2" aria-label="Retry email preference" onClick={() => void model.refresh()}>
            Retry
          </Button>
        ) : null}
      />
      {model.value && model.showFrequency ? <EmailFrequencySelect model={model} /> : null}
      {model.hasChanges || model.busy ? (
        <div className="flex justify-end px-4 pb-1">
          <Button data-voice-control-id="one_email_updates_save" type="submit" variant="link" className="min-h-11 px-2" disabled={model.busy} aria-label="Save email preference">
            {model.busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      <span role="status" className="sr-only">{model.saved ? "Email preference saved." : ""}</span>
    </form>
  );
}
