"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStableThemeSelection } from "@/components/theme-toggle";
import { readAccentPalette } from "@/components/app-ui/native-accent-choice";
import { useAccent, writeAccent } from "@/lib/theme/accent";
import { useSettings } from "@/lib/services/settings-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { nativeDrawers, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeProfileStyleScenePort } from "@/lib/capacitor/native-profile-style-scene";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { useCommunicationPreferencesEditor, type CommunicationPreferencesProps } from "./communication-preferences-section";
import { NativeStyleSheet } from "./native-writing-style-editor";

/** A complete settings page projection. Existing theme, Settings and encrypted
 * writing-style writers remain the only operation owners. No native persistence. */
export function useNativeProfilePreferences({ enabled, retainDraft, onGemini, onVoice, ...credentials }: {
  enabled: boolean; retainDraft: boolean; onGemini: () => void; onVoice: () => void;
} & Omit<CommunicationPreferencesProps, "onRequestUnlock" | "nativeScene">) {
  const { activeTheme, selectTheme } = useStableThemeSelection();
  const accent = useAccent();
  const [palette, setPalette] = useState(readAccentPalette);
  useLayoutEffect(() => { setPalette(current => current ?? readAccentPalette()); }, []);
  const [settings, updateSettings] = useSettings();
  const [savingHaptics, setSavingHaptics] = useState(false);
  const pendingHaptics = useRef(false);
  const mounted = useRef(true);
  const [styleOpen, setStyleOpen] = useState(false);
  const style = useCommunicationPreferencesEditor(retainDraft ? credentials : { userId: null, vaultKey: null, vaultOwnerToken: null });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!enabled) setStyleOpen(false); }, [enabled]);
  useEffect(() => { if (enabled && style.ready && style.suggested) setStyleOpen(true); }, [enabled, style.ready, style.suggested]);
  const changeHaptics = async (value: boolean) => {
    if (!enabled || !settings || pendingHaptics.current || settings.hapticFeedback === value) return;
    pendingHaptics.current = true;
    setSavingHaptics(true);
    const operation = updateSettings({ hapticFeedback: value });
    void morphyToast.promise(operation, { loading: "Saving…", success: "Saved", error: "Couldn’t save app haptics." });
    try { await operation; }
    finally { pendingHaptics.current = false; if (mounted.current) setSavingHaptics(false); }
  };
  const page: NativeProfilePage = { id: "preferences", title: "Appearance & preferences", sections: [
    { id: "preferences-appearance", rows: [
      { id: "preferences-theme", label: "Appearance", enabled: activeTheme !== null, artworkId: "appearance", options: [
        { id: "theme-light", label: "Light", symbol: "sun.max", selected: activeTheme === "light" },
        { id: "theme-dark", label: "Dark", symbol: "moon", selected: activeTheme === "dark" },
        { id: "theme-system", label: "System", symbol: "desktopcomputer", selected: activeTheme === "system" || activeTheme === null },
      ] },
      { id: "preferences-accent", label: "Accent", enabled: !!palette, artworkId: "accent", options: [
        { id: "accent-blue", label: "Blue", ...(palette ? { colorHex: palette.blue } : {}), selected: accent === "blue" },
        { id: "accent-gold", label: "Molten Gold", ...(palette ? { colorHex: palette.gold } : {}), selected: accent === "gold" },
      ] },
      { id: "preferences-haptics", label: "App haptics", enabled: !!settings && !savingHaptics, pending: savingHaptics, toggle: true,
        artworkId: "devices", options: [
          { id: "haptics-on", label: "On", selected: settings?.hapticFeedback === true },
          { id: "haptics-off", label: "Off", selected: settings?.hapticFeedback !== true },
        ] },
    ] },
    { id: "preferences-agent", rows: [
      { id: "preferences-gemini", label: "AI connection", detail: "Cloud connection or your own key.", enabled: true, artworkId: "ai-connection", chevron: true },
      { id: "preferences-voice", label: "Voice", detail: "Voice and safety controls.", enabled: true, artworkId: "voice", chevron: true },
    ] },
    { id: "preferences-writing", title: "How One writes to you", rows: [
      { id: "preferences-style", label: "Writing style", enabled: style.ready && !style.unavailable,
        artworkId: "style-tone", chevron: true, ...(style.loading ? { pending: true } : {}),
        ...(style.unavailable ? { detail: "Couldn’t load. Reopen to try again." } : style.suggested ? { trailing: "Suggested in Chat" } : style.dirty ? { trailing: "Unsaved" } : {}) },
    ] },
  ] };
  const rows: NativeDrawerActions["rows"] = new Map<string, () => void | Promise<void>>([
    ["theme-light", () => selectTheme("light")], ["theme-dark", () => selectTheme("dark")], ["theme-system", () => selectTheme("system")],
    ["accent-blue", () => { writeAccent("blue"); }], ["accent-gold", () => { writeAccent("gold"); }],
    ["haptics-on", () => changeHaptics(true)], ["haptics-off", () => changeHaptics(false)],
    ["preferences-gemini", onGemini], ["preferences-voice", onVoice], ["preferences-style", () => setStyleOpen(true)],
  ]);
  return { page, rows, formScene: enabled && styleOpen ? "writing-style" as const : null,
    editor: (destinationId?: string) => enabled && styleOpen && destinationId ?
    <NativeStyleSheet model={style} plugin={nativeDrawers() as ReturnType<typeof nativeDrawers> & NativeProfileStyleScenePort}
      destinationId={destinationId} onClose={() => setStyleOpen(false)} onFallback={() => {
        setStyleOpen(false); toast.error("Writing style couldn’t open. Please try again.");
      }} /> : null };
}
