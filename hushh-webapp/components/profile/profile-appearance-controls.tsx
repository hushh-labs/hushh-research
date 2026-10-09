"use client";

import { AccentRowIcon, AppearanceRowIcon, DevicesProfileIcon } from "@/components/icons/agents";
import { NativeAccentChoice } from "@/components/app-ui/native-accent-choice";
import { ThemeToggleLean } from "@/components/theme-toggle";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import type { AppAccent } from "@/lib/theme/accent";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/lib/services/settings-service";
import { usesNativeHapticPreference } from "@/lib/capacitor/app-haptics";
import { morphyToast } from "@/lib/morphy-ux/morphy";

/** Shared public controls; their existing theme/accent services own commits. */
export function ProfileAppearanceControls({ value, nativeContext }: {
  value: AppAccent;
  nativeContext: { owner: string | null; context: string; eligible: boolean };
}) {
  const [settings, updateSettings] = useSettings();
  const [saving, setSaving] = useState(false);
  const changeHaptics = async (hapticFeedback: boolean) => {
    if (saving) return;
    setSaving(true);
    const operation = updateSettings({ hapticFeedback });
    void morphyToast.promise(operation, { loading: "Saving…", success: "Saved", error: "Couldn’t save app haptics." });
    try { await operation; }
    catch { /* The action-bound toast owns transient failure feedback. */ }
    finally { setSaving(false); }
  };
  return <SettingsGroup rowSizing="uniform">
    <SettingsRow icon={AppearanceRowIcon} iconTone="capability" title="Appearance"
      trailing={<ThemeToggleLean size="compact" className="w-[132px] min-w-0" nativeContext={nativeContext} />} />
    <SettingsRow icon={AccentRowIcon} iconTone="capability" title="Accent"
      trailing={<NativeAccentChoice value={value} {...nativeContext} />} />
    {usesNativeHapticPreference() ? <SettingsRow icon={DevicesProfileIcon} iconTone="capability" title="App haptics"
      trailing={<div className="flex min-h-11 items-center"><Switch size="ios" aria-label="App haptics"
        checked={settings?.hapticFeedback ?? false} disabled={!settings || saving}
        onCheckedChange={value => void changeHaptics(value)} /></div>} /> : null}
  </SettingsGroup>;
}
