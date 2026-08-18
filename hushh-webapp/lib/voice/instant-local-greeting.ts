"use client";

import { createVoiceTurnId, logVoiceMetric } from "@/lib/voice/voice-telemetry";

/**
 * The relay's own greeting (consent-protocol/api/routes/one/adk_live.py)
 * takes a network round trip plus an idle hold plus model generation before
 * its first audio chunk arrives -- several seconds a returning, already-set-up
 * person spends looking at a silent mic. This speaks a fixed, local line the
 * instant the mic is tapped, using the device's own text-to-speech so it has
 * no dependency on the network or the model being ready.
 *
 * Deliberately not spoken for a fresh visitor or an onboarding screen: those
 * sessions still get the relay's richer, context-aware greeting (see
 * `_greeting_eligible` in adk_live.py), and this flat line would just be a
 * second, worse greeting stacked in front of it.
 */
const INSTANT_GREETING_TEXT = "Hi, how can I help?";

export function playInstantLocalGreeting(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    logVoiceMetric({
      metric: "voice_instant_greeting_unsupported",
      value: 1,
      turnId: createVoiceTurnId(),
    });
    return;
  }
  try {
    // Clears anything left over from a rapid double-tap so utterances never
    // queue up and play back to back.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(INSTANT_GREETING_TEXT);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
    logVoiceMetric({
      metric: "voice_instant_greeting_played",
      value: 1,
      turnId: createVoiceTurnId(),
    });
  } catch (error) {
    logVoiceMetric({
      metric: "voice_instant_greeting_failed",
      value: 1,
      turnId: createVoiceTurnId(),
      tags: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Stop a still-playing instant greeting the moment real model audio starts,
 * so the two can never overlap regardless of how fast the connection is. */
export function stopInstantLocalGreeting(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    window.speechSynthesis.cancel();
  }
}
