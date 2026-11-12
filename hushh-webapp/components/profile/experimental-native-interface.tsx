"use client";

import { useEffect, useRef, useState } from "react";
import { customNativePresentationEnabled, nativeInterfacePreferenceAvailable } from "@/lib/capacitor/native-presentation-policy";
import { useSettings } from "@/lib/services/settings-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Both presentations use the existing device settings writer. Admission is
 * still the immutable native bootstrap, never this mutable requested value. */
export function useExperimentalNativeInterface() {
  const [settings, updateSettings] = useSettings();
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useEffect(() => { setAvailable(nativeInterfacePreferenceAvailable()); }, []);
  const change = async (value: boolean) => {
    if (!available || !settings || pending.current || settings.experimentalNativeInterface === value) return;
    pending.current = true; setSaving(true);
    try {
      await updateSettings({ experimentalNativeInterface: value });
      morphyToast.success(value === customNativePresentationEnabled() ? "Pending interface change cancelled." : "Saved. Fully close and reopen the app to apply.");
    } catch { morphyToast.error("Couldn’t save the native interface preference."); }
    finally { pending.current = false; setSaving(false); }
  };
  const active = customNativePresentationEnabled();
  const selected = settings?.experimentalNativeInterface === true;
  const pendingChange = available && settings !== null && selected !== active;
  const description = pendingChange
    ? `Experimental. ${active ? "Native" : "Standard"} is active now. Fully close and reopen the app to use ${selected ? "native" : "standard"}.`
    : `Experimental. ${active ? "Native" : "Standard"} is active now.`;
  return { available, active, selected, pendingChange, description, ready: settings !== null, saving, change };
}

export function ExperimentalNativeInterface() {
  const preference = useExperimentalNativeInterface();
  if (!preference.available) return null;
  return <SettingsGroup rowSizing="uniform">
    <SettingsRow icon={PROFILE_ICONS.appearance} iconTone="capability" title="Native interface"
      description={preference.description}
      trailing={<Switch size="ios" aria-label="Experimental native interface" data-testid="experimental-native-interface"
        checked={preference.selected} disabled={!preference.ready || preference.saving}
        onCheckedChange={value => void preference.change(value)} />} />
    {preference.pendingChange ? <SettingsRow title="Keep current interface" description="Cancel the pending change." onClick={() => void preference.change(preference.active)} disabled={preference.saving} /> : null}
  </SettingsGroup>;
}
