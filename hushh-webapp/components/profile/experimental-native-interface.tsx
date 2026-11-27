"use client";

import { useInterfaceRevision } from "@/lib/capacitor/native-interface-revision";
import { useEffect, useRef, useState } from "react";
import { applySavedNativeInterface } from "@/lib/capacitor/apply-native-interface";
import { customNativePresentationEnabled, liveInterfaceSwitchAvailable, nativeInterfacePreferenceAvailable } from "@/lib/capacitor/native-presentation-policy";
import { useSettings } from "@/lib/services/settings-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "./settings-ui";

export function useExperimentalNativeInterface() {
  useInterfaceRevision();
  const [settings, updateSettings] = useSettings();
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useEffect(() => { setAvailable(nativeInterfacePreferenceAvailable()); }, []);
  const change = async (value: boolean) => {
    if (!available || !settings || pending.current || (settings.experimentalNativeInterface === value && customNativePresentationEnabled() === value)) return;
    pending.current = true; setSaving(true);
    try {
      if (settings.experimentalNativeInterface !== value) await updateSettings({ experimentalNativeInterface: value });
      if (value === customNativePresentationEnabled()) {
        morphyToast.success("Current interface kept.");
      } else if (!await applySavedNativeInterface(value)) {
        morphyToast.success("Saved. Reopen the app to apply this interface.");
      }
    } catch { morphyToast.error("Couldn’t apply the interface change. Check your preference and try again."); }
    finally { pending.current = false; setSaving(false); }
  };
  const active = customNativePresentationEnabled();
  const saved = settings?.experimentalNativeInterface === true;
  const live = liveInterfaceSwitchAvailable();
  const selected = live ? active : saved;
  const pendingChange = available && settings !== null && saved !== active;
  const description = pendingChange
    ? live ? `Experimental. ${active ? "Native" : "Standard"} is active. Tap the switch to apply the saved choice.`
      : `Experimental. ${active ? "Native" : "Standard"} is active now. Fully close and reopen the app to use ${saved ? "native" : "standard"}.`
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
