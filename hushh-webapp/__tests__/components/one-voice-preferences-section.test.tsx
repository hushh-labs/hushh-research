import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OneVoicePreferencesSection,
  describeOneVoiceLiveStatus,
  forgetSpeakerphoneSafePreference,
  readSpeakerphoneSafePreference,
  speakerphoneSafePreferenceKey,
  subscribeSpeakerphoneSafePreference,
  writeSpeakerphoneSafePreference,
} from "@/components/profile/one-voice-preferences-section";
import type { OneVoiceReadiness } from "@/lib/one-voice/readiness";
import { useOneVoiceReadiness } from "@/lib/one-voice/readiness";

vi.mock("@/lib/one-voice/readiness", () => ({
  useOneVoiceReadiness: vi.fn(),
}));

// Owned by components/one-voice; the section only places it.
vi.mock("@/components/one-voice/voice-microphone-check", () => ({
  VoiceMicrophoneCheck: () => (
    <div data-testid="voice-microphone-check">Microphone check</div>
  ),
}));

const UNKNOWN: OneVoiceReadiness = {
  status: "unknown",
  liveEnabled: false,
  model: null,
  location: null,
  wsPath: null,
};

function resolved(
  overrides: Partial<Extract<OneVoiceReadiness, { status: "resolved" }>>,
): OneVoiceReadiness {
  return {
    status: "resolved",
    liveEnabled: false,
    serverStatus: "disabled",
    model: null,
    location: null,
    wsPath: "/api/one/voice/live",
    ...overrides,
  };
}

describe("describeOneVoiceLiveStatus", () => {
  it("is Ready only when the server said enabled AND ready", () => {
    expect(
      describeOneVoiceLiveStatus(
        resolved({
          liveEnabled: true,
          serverStatus: "ready",
          model: "gemini-live",
        }),
      ),
    ).toMatchObject({ status: "ready", label: "Ready" });
    // A stale "enabled" without a ready provider never reads as Ready.
    expect(
      describeOneVoiceLiveStatus(
        resolved({ liveEnabled: true, serverStatus: "provider_unavailable" }),
      ),
    ).toMatchObject({ status: "unavailable", label: "Unavailable" });
  });

  it("reads Off when the server disabled Live", () => {
    expect(
      describeOneVoiceLiveStatus(resolved({ serverStatus: "disabled" })),
    ).toMatchObject({
      status: "off",
      label: "Off",
    });
  });

  it("reads Unavailable for not_configured and provider_unavailable", () => {
    expect(
      describeOneVoiceLiveStatus(resolved({ serverStatus: "not_configured" })),
    ).toMatchObject({ status: "unavailable", label: "Unavailable" });
    expect(
      describeOneVoiceLiveStatus(
        resolved({ serverStatus: "provider_unavailable" }),
      ),
    ).toMatchObject({ status: "unavailable", label: "Unavailable" });
  });

  it("is Checking before the server has answered", () => {
    expect(describeOneVoiceLiveStatus(UNKNOWN)).toMatchObject({
      status: "checking",
      label: "Checking",
    });
  });
});

describe("speakerphone-safe preference storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetSpeakerphoneSafePreference("user-1");
  });

  it("lives in the voice preferences namespace and defaults to off", () => {
    expect(speakerphoneSafePreferenceKey("user-1")).toBe(
      "one_voice_preferences_v1:user-1:speakerphone_safe",
    );
    expect(readSpeakerphoneSafePreference("user-1")).toBe(false);
    expect(readSpeakerphoneSafePreference(null)).toBe(false);
  });

  it("round-trips through storage and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpeakerphoneSafePreference("user-1", listener);
    writeSpeakerphoneSafePreference("user-1", true);
    expect(listener).toHaveBeenCalledWith(true);
    expect(
      window.localStorage.getItem(speakerphoneSafePreferenceKey("user-1")),
    ).toBe("1");
    expect(readSpeakerphoneSafePreference("user-1")).toBe(true);
    unsubscribe();
    writeSpeakerphoneSafePreference("user-1", false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readSpeakerphoneSafePreference("user-1")).toBe(false);
  });

  it("is per user", () => {
    writeSpeakerphoneSafePreference("user-1", true);
    expect(readSpeakerphoneSafePreference("user-2")).toBe(false);
  });
});

describe("OneVoicePreferencesSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetSpeakerphoneSafePreference("user-1");
    vi.mocked(useOneVoiceReadiness).mockReturnValue(UNKNOWN);
  });

  it("renders the three rows: live status, microphone check, speakerphone-safe switch", () => {
    vi.mocked(useOneVoiceReadiness).mockReturnValue(
      resolved({
        liveEnabled: true,
        serverStatus: "ready",
        model: "gemini-live",
      }),
    );
    render(<OneVoicePreferencesSection userId="user-1" />);

    expect(
      screen.getByTestId("one-voice-preferences-section"),
    ).toBeInTheDocument();
    expect(screen.getByText("Talk to One (live)")).toBeInTheDocument();
    expect(screen.getByTestId("one-voice-live-status")).toHaveTextContent(
      "Ready",
    );
    expect(screen.getByTestId("one-voice-live-status")).toHaveAttribute(
      "data-status",
      "ready",
    );
    expect(screen.getByTestId("voice-microphone-check")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Speakerphone-safe mode" }),
    ).toBeInTheDocument();

    // The status row is read-only: no switch or button controls Live here.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: /live/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Off when the server disabled Live", () => {
    vi.mocked(useOneVoiceReadiness).mockReturnValue(
      resolved({ serverStatus: "disabled" }),
    );
    render(<OneVoicePreferencesSection userId="user-1" />);
    expect(screen.getByTestId("one-voice-live-status")).toHaveTextContent(
      "Off",
    );
  });

  it("shows Unavailable when the provider cannot be reached", () => {
    vi.mocked(useOneVoiceReadiness).mockReturnValue(
      resolved({ serverStatus: "provider_unavailable" }),
    );
    render(<OneVoicePreferencesSection userId="user-1" />);
    expect(screen.getByTestId("one-voice-live-status")).toHaveTextContent(
      "Unavailable",
    );
  });

  it("persists the speakerphone-safe switch per user", () => {
    render(<OneVoicePreferencesSection userId="user-1" />);
    const toggle = screen.getByRole("switch", {
      name: "Speakerphone-safe mode",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(readSpeakerphoneSafePreference("user-1")).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(readSpeakerphoneSafePreference("user-1")).toBe(false);
  });

  it("reads a stored preference on mount and follows external writes", () => {
    writeSpeakerphoneSafePreference("user-1", true);
    render(<OneVoicePreferencesSection userId="user-1" />);
    const toggle = screen.getByRole("switch", {
      name: "Speakerphone-safe mode",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    act(() => {
      writeSpeakerphoneSafePreference("user-1", false);
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("disables the switch without a signed-in user", () => {
    render(<OneVoicePreferencesSection userId={null} />);
    expect(
      screen.getByRole("switch", { name: "Speakerphone-safe mode" }),
    ).toBeDisabled();
  });
});
