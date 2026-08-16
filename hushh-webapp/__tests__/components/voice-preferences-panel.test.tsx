import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VoicePreferencesPanel } from "@/components/profile/voice-preferences-panel";
import {
  forgetVoicePreferences,
  readVoicePreferences,
} from "@/lib/agent/voice-preferences";
import { VOICE_ENGINE_VERSION } from "@/lib/agent/voice-engine-changelog";

const userId = "voice-preferences-panel-user";

afterEach(() => {
  forgetVoicePreferences(userId);
});

describe("VoicePreferencesPanel", () => {
  it("shows the One header with the current engine version", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
    expect(
      screen.getByText(
        `Voice engine version ${VOICE_ENGINE_VERSION} — powered by Gemini Live`,
      ),
    ).toBeInTheDocument();
  });

  it("opens with voice on and every enforceable domain allowed, matching today's behavior", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByRole("switch", { name: "Voice control" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Location" }),
    ).toBeChecked();
  });

  it("Finance and Calendar show as coming soon, not a switch", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.queryByRole("switch", { name: "Finance" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Calendar" })).toBeNull();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  });

  it("turning off a domain persists to voice preferences", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    fireEvent.click(screen.getByRole("switch", { name: "Location" }));

    expect(readVoicePreferences(userId).disabledDomains).toEqual(["location"]);
  });

  it("turning off the master toggle disables the domain and safety switches", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    fireEvent.click(screen.getByRole("switch", { name: "Voice control" }));

    expect(readVoicePreferences(userId).voiceEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Location" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Require a tap to confirm risky actions" }),
    ).toBeDisabled();
  });

  it("changelog shows a preview and expands to the full list", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByText("What's new")).toBeInTheDocument();
    const seeAll = screen.getByRole("button", { name: "See all updates" });
    expect(seeAll).toBeInTheDocument();

    fireEvent.click(seeAll);

    expect(screen.queryByRole("button", { name: "See all updates" })).toBeNull();
  });
});
