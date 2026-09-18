"use client";

/**
 * The "Talk to One (live)" block at the top of Profile > Preferences > Voice.
 *
 * Three rows:
 * - a read-only status row driven by the server-owned readiness flag
 *   (`GET /api/one/voice/readiness`); nothing here can turn Live on or off,
 * - the microphone check (owned by components/one-voice),
 * - a "Speakerphone-safe mode" switch that forces the half-duplex gate so a
 *   phone without echo cancellation stops hearing itself. Stored per user in
 *   the voice preferences namespace (`one_voice_preferences_v1:<uid>:...`).
 */

import { useEffect, useState } from "react";
import {
  EarIcon as Ear,
  BroadcastIcon as Radio,
} from "@/components/icons";

import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { VoiceMicrophoneCheck } from "@/components/one-voice/voice-microphone-check";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  useOneVoiceReadiness,
  type OneVoiceReadiness,
} from "@/lib/one-voice/readiness";

// --- Speakerphone-safe preference ---------------------------------------------
//
// `lib/agent/voice-preferences.ts` sanitises its record to a fixed shape, so
// this flag lives beside it under the same key prefix instead of inside it.
// The Live session provider reads it through `readSpeakerphoneSafePreference`
// and passes it as `forced` to `decideHalfDuplex`.

const SPEAKERPHONE_SAFE_KEY_PREFIX = "one_voice_preferences_v1:";
const SPEAKERPHONE_SAFE_KEY_SUFFIX = ":speakerphone_safe";

const speakerphoneRuntimeByUser = new Map<string, boolean>();
const speakerphoneListenersByUser = new Map<
  string,
  Set<(value: boolean) => void>
>();

export function speakerphoneSafePreferenceKey(userId: string): string {
  return `${SPEAKERPHONE_SAFE_KEY_PREFIX}${userId}${SPEAKERPHONE_SAFE_KEY_SUFFIX}`;
}

/** True when the person asked Live to stay half-duplex on this device. */
export function readSpeakerphoneSafePreference(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  const runtime = speakerphoneRuntimeByUser.get(userId);
  if (typeof runtime === "boolean") return runtime;
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(speakerphoneSafePreferenceKey(userId)) === "1"
    );
  } catch {
    return false;
  }
}

export function writeSpeakerphoneSafePreference(
  userId: string | null | undefined,
  enabled: boolean,
): boolean {
  if (!userId) return false;
  speakerphoneRuntimeByUser.set(userId, enabled);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        speakerphoneSafePreferenceKey(userId),
        enabled ? "1" : "0",
      );
    } catch {
      // The in-memory value stays authoritative for this session.
    }
  }
  for (const listener of speakerphoneListenersByUser.get(userId) ?? []) {
    listener(enabled);
  }
  return enabled;
}

export function subscribeSpeakerphoneSafePreference(
  userId: string,
  listener: (enabled: boolean) => void,
): () => void {
  const listeners =
    speakerphoneListenersByUser.get(userId) ??
    new Set<(value: boolean) => void>();
  listeners.add(listener);
  speakerphoneListenersByUser.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) speakerphoneListenersByUser.delete(userId);
  };
}

/** Best-effort account-deletion cleanup for restricted browser storage. */
export function forgetSpeakerphoneSafePreference(
  userId: string | null | undefined,
): void {
  if (!userId) return;
  speakerphoneRuntimeByUser.delete(userId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(speakerphoneSafePreferenceKey(userId));
    } catch {
      // Nothing further to do -- the runtime value is already cleared.
    }
  }
  for (const listener of speakerphoneListenersByUser.get(userId) ?? []) {
    listener(false);
  }
}

// --- Live status ----------------------------------------------------------------

export type OneVoiceLiveStatus = "checking" | "ready" | "off" | "unavailable";

/** Fold the readiness record into the three words the row can show. */
export function describeOneVoiceLiveStatus(readiness: OneVoiceReadiness): {
  status: OneVoiceLiveStatus;
  label: string;
  description: string;
} {
  if (readiness.status !== "resolved") {
    return {
      status: "checking",
      label: "Checking",
      description: "Asking the server whether live voice is available.",
    };
  }
  if (readiness.liveEnabled && readiness.serverStatus === "ready") {
    return {
      status: "ready",
      label: "Ready",
      description: readiness.model
        ? `Hold Talk to One to speak with ${readiness.model}.`
        : "Hold Talk to One to speak.",
    };
  }
  if (readiness.serverStatus === "disabled") {
    return {
      status: "off",
      label: "Off",
      description:
        "Live voice is turned off for this account. Push-to-talk commands still work.",
    };
  }
  return {
    status: "unavailable",
    label: "Unavailable",
    description:
      readiness.serverStatus === "provider_unavailable"
        ? "The voice provider can't be reached right now. Push-to-talk commands still work."
        : "Live voice isn't set up on this server yet. Push-to-talk commands still work.",
  };
}

const STATUS_BADGE_VARIANT: Record<
  OneVoiceLiveStatus,
  "default" | "secondary" | "outline"
> = {
  checking: "outline",
  ready: "default",
  off: "secondary",
  unavailable: "secondary",
};

export function OneVoicePreferencesSection({
  userId,
}: {
  userId: string | null;
}) {
  const readiness = useOneVoiceReadiness();
  const live = describeOneVoiceLiveStatus(readiness);

  const [speakerphoneSafe, setSpeakerphoneSafe] = useState<boolean>(() =>
    readSpeakerphoneSafePreference(userId),
  );

  useEffect(() => {
    setSpeakerphoneSafe(readSpeakerphoneSafePreference(userId));
    if (!userId) return;
    return subscribeSpeakerphoneSafePreference(userId, setSpeakerphoneSafe);
  }, [userId]);

  return (
    <SettingsGroup
      title="Talk to One (live)"
      description="A hands-free conversation with One. The server decides whether it's on."
      testId="one-voice-preferences-section"
    >
      <SettingsRow
        icon={Radio}
        iconTone={live.status === "ready" ? "green" : "gray"}
        title="Live voice"
        description={live.description}
        trailing={
          <Badge
            variant={STATUS_BADGE_VARIANT[live.status]}
            data-testid="one-voice-live-status"
            data-status={live.status}
          >
            {live.label}
          </Badge>
        }
        testId="one-voice-live-status-row"
      />
      {/* Renders its own row body; the group's dividers and the row padding
          tokens keep it flush with the SettingsRows around it. */}
      <VoiceMicrophoneCheck className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]" />
      <SettingsRow
        icon={Ear}
        iconTone="orange"
        title="Speakerphone-safe mode"
        description="Pauses your microphone while One is talking so the speaker can't interrupt itself. Use it on a phone without echo cancellation."
        trailing={
          <Switch
            checked={speakerphoneSafe}
            disabled={!userId}
            onCheckedChange={(checked) => {
              setSpeakerphoneSafe(checked);
              writeSpeakerphoneSafePreference(userId, checked);
            }}
            aria-label="Speakerphone-safe mode"
          />
        }
        testId="one-voice-speakerphone-safe-row"
      />
    </SettingsGroup>
  );
}
