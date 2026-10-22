"use client";

import { toast } from "sonner";
import type { NativeDrawerRow, NativeDrawerSection, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { VOICE_ENGINE_DOMAINS } from "@/lib/agent/voice-engine-domains";
import { useOneVoiceReadiness } from "@/lib/one-voice/readiness";
import { formatSampleRate, useVoiceMicrophoneCheck } from "@/components/one-voice/voice-microphone-check";
import { describeOneVoiceLiveStatus } from "./one-voice-preferences-section";
import { useVoiceCommandPreferences, useVoiceSpeakerphonePreference, useVoicePreferenceOwner } from "./use-voice-policy-preferences";
import { useVoiceConnectDefaults, useVoiceLocationDefaults } from "./use-voice-preferences-model";

/** A complete bounded Voice page under Preferences. The existing feature
 * models perform every operation; native receives presentation and action IDs
 * only, never the auth callback, owner token, audio frames or a second store. */
export function useNativeVoiceProfile({ enabled, userId, vaultOwnerToken, getIdToken }: {
  enabled: boolean; userId: string | null; vaultOwnerToken: string | null; getIdToken: (() => Promise<string>) | null;
}) {
  const owner = enabled ? userId : null;
  const current = useVoicePreferenceOwner(owner);
  const commands = useVoiceCommandPreferences(owner);
  const speaker = useVoiceSpeakerphonePreference(owner);
  const location = useVoiceLocationDefaults(owner, owner ? vaultOwnerToken : null);
  const connect = useVoiceConnectDefaults(owner, owner ? getIdToken : null);
  const microphone = useVoiceMicrophoneCheck({ enabled: !!owner, ownerKey: owner });
  const live = describeOneVoiceLiveStatus(useOneVoiceReadiness());
  const actions = new Map<string, () => void | Promise<void>>();
  const action = (id: string, run: () => void | Promise<void>) => actions.set(id, () => { if (current()) return run(); });
  const binary = (id: string, label: string, selected: boolean, change: (value: boolean) => void | Promise<boolean>,
    detail?: string, allowed = !!owner, pending = false): NativeDrawerRow => {
    for (const value of [true, false]) action(`${id}-${value ? "on" : "off"}`, async () => {
      if (!allowed || selected === value) return;
      const applied = await change(value);
      if (applied === false && current()) toast.error("Couldn’t save this preference. Please try again.");
    });
    return { id, label, ...(detail ? { detail } : {}), enabled: allowed && !pending, pending, toggle: true,
      options: [true, false].map(value => ({ id: `${id}-${value ? "on" : "off"}`, label: value ? "On" : "Off", selected: selected === value })) };
  };
  action("voice-microphone-test", () => { void microphone.run(); });
  const sections: NativeDrawerSection[] = [
    { id: "voice-live", title: "Talk to One (live)", rows: [
      { id: "voice-readiness", label: "Live voice", detail: live.description, trailing: live.label, artworkId: "voice", enabled: true, readOnly: true },
      { id: "voice-microphone-test", label: "Microphone", detail: "Three seconds of level, then a short tone. Nothing is recorded or sent.",
        trailing: microphone.label, enabled: !!owner && !microphone.busy, pending: microphone.busy },
      binary("voice-speaker-safe", "Speakerphone-safe mode", speaker.value, speaker.change,
        "Pauses your microphone while One is talking so the speaker can’t interrupt itself."),
    ] },
    { id: "voice-command-policy", title: "Commands", rows: [
      binary("voice-command-enabled", "Voice control", commands.state.voiceEnabled,
        value => commands.change(state => ({ ...state, voiceEnabled: value })), "Let One act on what you say."),
      { id: "voice-command-help", label: "Use your own words", detail: "Hold Talk to One, speak, and release. One interprets your request from the current context.", enabled: true, readOnly: true },
      { id: "voice-command-confirmation", label: "Confirm sensitive actions", detail: "Actions that require approval show a card. Tap Confirm to continue.", enabled: true, readOnly: true },
    ] },
  ];
  if (microphone.phase === "done" || microphone.phase === "failed") {
    const report = microphone.report;
    const rows: NativeDrawerRow[] = [{ id: "voice-microphone-result", label: microphone.phase === "failed"
      ? "Microphone check couldn’t finish" : report.heard ? "Microphone works" : "We didn’t hear anything",
      ...(microphone.error?.code === "not_allowed" ? { detail: "Allow microphone access in device settings, then try again." } : {}), enabled: true, readOnly: true }];
    const facts: [string, string, string][] = [
      ["sample", "Sample rate", formatSampleRate(report.sampleRate)],
      ["echo", "Echo cancellation", report.echoCancellation === null ? "Unknown" : report.echoCancellation ? "On" : "Off"],
      ["worklet", "Capture worklet", report.workletLoaded ? "Loaded" : "Not loaded"],
    ];
    if (microphone.phase === "done") facts.push(["tone", "Test tone", report.tonePlayed ? "Played" : "Could not play"]);
    for (const [id, label, value] of facts) rows.push({ id: `voice-microphone-${id}`, label, trailing: value, enabled: true, readOnly: true });
    sections.push({ id: "voice-microphone-report", title: "Microphone check", rows });
  }
  if (location.defaults) {
    const value = location.defaults;
    action("voice-sos-open", async () => {
      if (value.sosDefaultAction !== "open" && !await location.setSos("open") && current()) toast.error("Couldn’t save this preference.");
    });
    action("voice-sos-trigger", async () => {
      if (value.sosDefaultAction !== "trigger" && !await location.setSos("trigger") && current()) toast.error("Couldn’t save this preference.");
    });
    sections.push({ id: "voice-location", title: "Location", rows: [
      binary("voice-auto-approve", "Auto-approve requests", value.autoApproveRequests, location.setAutoApprove,
        "Let matching location requests through automatically.", true, location.pending.has("autoApprove")),
      binary("voice-nearby-visible", "Visible in Nearby Check-In", value.nearbyCheckInVisible,
        checked => location.setNearby({ nearbyCheckInVisible: checked }), "Show up to people nearby when you check in.", true, location.pending.has("nearby")),
      binary("voice-nearby-connect", "Allow connection requests", value.nearbyCheckInAllowConnectionRequests,
        checked => location.setNearby({ nearbyCheckInAllowConnectionRequests: checked }), "Let people who see you checked in ask to connect.", true, location.pending.has("nearby")),
      { id: "voice-emergency", label: "In an emergency", detail: "A bare “save me” or “SOS” uses this choice. Still confirmed before anything sends.",
        enabled: !location.pending.has("sos"), pending: location.pending.has("sos"), options: [
          { id: "voice-sos-open", label: "Open the screen", selected: value.sosDefaultAction === "open" },
          { id: "voice-sos-trigger", label: "Send the alert", selected: value.sosDefaultAction === "trigger" },
        ] },
    ] });
  } else if (owner && vaultOwnerToken) {
    action("voice-location-retry", location.reload);
    sections.push({ id: "voice-location", title: "Location", rows: [{ id: "voice-location-retry",
      label: location.status === "loading" ? "Loading defaults…" : "Couldn’t load defaults", trailing: location.status === "loading" ? undefined : "Try again",
      enabled: location.status === "unavailable", pending: location.status === "loading" }] });
  }
  if (connect.shareScopes !== null) {
    sections.push({ id: "voice-connect", title: "Connect", rows: [binary("voice-reuse-access", "Reuse access from last time", connect.shareScopes,
      connect.setShareScopes, "A repeat request asks for and offers the same access you did with that person before. They still approve every request.", true, connect.pending)] });
  } else if (owner && getIdToken) {
    action("voice-connect-retry", connect.reload);
    sections.push({ id: "voice-connect", title: "Connect", rows: [{ id: "voice-connect-retry",
      label: connect.status === "loading" ? "Loading defaults…" : "Couldn’t load defaults", trailing: connect.status === "loading" ? undefined : "Try again",
      enabled: connect.status === "unavailable", pending: connect.status === "loading" }] });
  }
  sections.push({ id: "voice-domains", title: "What voice can control", rows: VOICE_ENGINE_DOMAINS.map(domain => domain.enforced
    ? binary(`voice-domain-${domain.key}`, domain.label, !commands.state.disabledDomains.includes(domain.key), allowed => commands.change(state => ({
      ...state, disabledDomains: allowed ? state.disabledDomains.filter(key => key !== domain.key) : [...new Set([...state.disabledDomains, domain.key])],
    })), domain.description, !!owner && commands.state.voiceEnabled)
    : { id: `voice-domain-${domain.key}`, label: domain.label, detail: domain.description, trailing: "Coming soon", enabled: false, readOnly: true }) });
  const page: NativeProfilePage = { id: "voice", title: "Voice", sections };
  return { page, rows: actions as NativeDrawerActions["rows"] };
}
