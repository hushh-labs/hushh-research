import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
    expect(
      screen.getByText(
        `Voice engine ${VOICE_ENGINE_VERSION} — powered by Gemini Live`,
      ),
    ).toBeInTheDocument();
  });

  it("opens with voice on and every enforceable domain allowed, matching today's behavior", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    expect(screen.getByRole("switch", { name: "Voice control" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Location" }),
    ).toBeChecked();
  });

  it("Finance and Calendar show as coming soon, not a switch", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    expect(screen.queryByRole("switch", { name: "Finance" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Calendar" })).toBeNull();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  });

  it("turning off a domain persists to voice preferences", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Location" }));

    expect(readVoicePreferences(userId).disabledDomains).toEqual(["location"]);
  });

  it("turning off the master toggle disables the domain and safety switches", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Voice control" }));

    expect(readVoicePreferences(userId).voiceEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Location" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Require a tap to confirm" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Walk-through mode" }),
    ).toBeDisabled();
  });

  it("walk-through mode defaults on and persists when turned off", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    const toggle = screen.getByRole("switch", { name: "Walk-through mode" });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(readVoicePreferences(userId).walkthroughMode).toBe(false);
    expect(toggle).not.toBeChecked();
  });

  it("changelog shows a preview and \"See all updates\" opens the dedicated changelog page", () => {
    const onOpenChangelog = vi.fn();
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={onOpenChangelog} onOpenExamples={() => {}} />,
    );

    expect(screen.getByText("What's new")).toBeInTheDocument();
    const seeAll = screen.getByRole("button", { name: "See all updates" });
    expect(seeAll).toBeInTheDocument();

    fireEvent.click(seeAll);

    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
  });

  it("voice defaults to Default and persists a pick", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    expect(
      screen.getByRole("combobox", { name: "Voice" }).textContent,
    ).toContain("Default");

    fireEvent.click(screen.getByRole("combobox", { name: "Voice" }));
    fireEvent.click(screen.getByRole("option", { name: "Leda — Youthful" }));

    expect(readVoicePreferences(userId).voiceName).toBe("Leda");
  });

  it("turning off the master toggle disables the voice picker too", () => {
    render(
      <VoicePreferencesPanel userId={userId} onOpenChangelog={() => {}} onOpenExamples={() => {}} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Voice control" }));

    expect(screen.getByRole("combobox", { name: "Voice" })).toBeDisabled();
  });

  it("\"What can I say\" opens the examples page", () => {
    const onOpenExamples = vi.fn();
    render(
      <VoicePreferencesPanel
        userId={userId}
        onOpenChangelog={() => {}}
        onOpenExamples={onOpenExamples}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /What can I say/ }));

    expect(onOpenExamples).toHaveBeenCalledTimes(1);
  });
});
