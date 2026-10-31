import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetVoicePreferences,
  readVoicePreferences,
  subscribeVoicePreferences,
  updateVoicePreferences,
} from "@/lib/agent/voice-preferences";

const userId = "voice-preferences-user";
const defaultState = {
  voiceEnabled: true,
  requireTapConfirmation: false,
  disabledDomains: [],
};

afterEach(() => {
  forgetVoicePreferences(userId);
});

describe("Talk to One command preferences", () => {
  it("uses unrestricted command defaults for a person who has not changed settings", () => {
    expect(readVoicePreferences(userId)).toEqual(defaultState);
    expect(readVoicePreferences(null)).toEqual(defaultState);
    expect(readVoicePreferences(undefined)).toEqual(defaultState);
  });

  it("persists command restrictions across a fresh read", () => {
    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: false,
      requireTapConfirmation: true,
      disabledDomains: ["location"],
    }));

    expect(readVoicePreferences(userId)).toEqual({
      voiceEnabled: false,
      requireTapConfirmation: true,
      disabledDomains: ["location"],
    });
  });

  it("fails open on corrupt storage and drops malformed disabled domains", () => {
    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      "{not valid json",
    );
    expect(readVoicePreferences(userId)).toEqual(defaultState);

    window.localStorage.setItem(
      `one_voice_preferences_v1:${userId}`,
      JSON.stringify({ disabledDomains: ["location", 7, null, "email", ""] }),
    );
    expect(readVoicePreferences(userId).disabledDomains).toEqual([
      "location",
      "email",
    ]);
  });

  it("notifies subscribers only while subscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoicePreferences(userId, listener);
    updateVoicePreferences(userId, (current) => ({
      ...current,
      voiceEnabled: false,
    }));
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

  it("forgets persisted preferences on account cleanup", () => {
    updateVoicePreferences(userId, (current) => ({
      ...current,
      disabledDomains: ["kyc"],
    }));
    forgetVoicePreferences(userId);
    expect(readVoicePreferences(userId)).toEqual(defaultState);
    expect(
      window.localStorage.getItem(`one_voice_preferences_v1:${userId}`),
    ).toBeNull();
  });
});
