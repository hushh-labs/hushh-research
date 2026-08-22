import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetVoicePreferences,
  readVoicePreferences,
  subscribeVoicePreferences,
  updateVoicePreferences,
} from "@/lib/agent/voice-preferences";

const userId = "voice-preferences-user";

afterEach(() => {
  forgetVoicePreferences(userId);
});

describe("One voice preferences", () => {
  it("reproduces today's exact behavior for a user who never opens the panel", () => {
    expect(readVoicePreferences(userId)).toEqual({
      voiceEnabled: true,
      requireTapConfirmation: false,
      walkthroughMode: true,
      disabledDomains: [],
    });
  });

  it("fails open, not closed, without a userId", () => {
    expect(readVoicePreferences(null)).toEqual({
      voiceEnabled: true,
      requireTapConfirmation: false,
      walkthroughMode: true,
      disabledDomains: [],
    });
    expect(readVoicePreferences(undefined)).toEqual({
      voiceEnabled: true,
      requireTapConfirmation: false,
      walkthroughMode: true,
      disabledDomains: [],
    });
  });

  it("persists a change across a fresh read", () => {
    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: false,
      requireTapConfirmation: true,
      walkthroughMode: true,
      disabledDomains: ["location"],
    }));

    expect(readVoicePreferences(userId)).toEqual({
      voiceEnabled: false,
      requireTapConfirmation: true,
      walkthroughMode: true,
      disabledDomains: ["location"],
    });
  });

  it("fails open on a corrupted store rather than reading as fully restricted", () => {
    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      "{not valid json",
    );

    expect(readVoicePreferences(userId)).toEqual({
      voiceEnabled: true,
      requireTapConfirmation: false,
      walkthroughMode: true,
      disabledDomains: [],
    });
  });

  it("drops non-string entries from a malformed disabledDomains array", () => {
    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      JSON.stringify({
        voiceEnabled: true,
        requireTapConfirmation: false,
        disabledDomains: ["location", 7, null, "email", ""],
      }),
    );

    expect(readVoicePreferences(userId).disabledDomains).toEqual([
      "location",
      "email",
    ]);
  });

  it("reads walkthroughMode as on unless it is exactly false", () => {
    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      JSON.stringify({ voiceEnabled: true, walkthroughMode: "no" }),
    );

    expect(readVoicePreferences(userId).walkthroughMode).toBe(true);

    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      JSON.stringify({ voiceEnabled: true, walkthroughMode: false }),
    );

    expect(readVoicePreferences(userId).walkthroughMode).toBe(false);
  });

  it("notifies subscribers on update, and stops after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoicePreferences(userId, listener);

    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: false,
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ voiceEnabled: false }),
    );

    unsubscribe();
    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: true,
    }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forgetting preferences clears storage and restores the default", () => {
    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: false,
      disabledDomains: ["kyc"],
    }));

    forgetVoicePreferences(userId);

    expect(readVoicePreferences(userId)).toEqual({
      voiceEnabled: true,
      requireTapConfirmation: false,
      walkthroughMode: true,
      disabledDomains: [],
    });
    expect(
      window.localStorage.getItem(`one_voice_preferences_v1:${userId}`),
    ).toBeNull();
  });
});
