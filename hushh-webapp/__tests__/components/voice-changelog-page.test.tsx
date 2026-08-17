import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VoiceChangelogPage } from "@/components/profile/voice-changelog-page";
import { VOICE_ENGINE_CHANGELOG } from "@/lib/agent/voice-engine-changelog";

describe("VoiceChangelogPage", () => {
  it("renders every changelog entry, not just a capped preview", () => {
    render(<VoiceChangelogPage />);

    for (const entry of VOICE_ENGINE_CHANGELOG) {
      expect(screen.getByText(entry.title)).toBeInTheDocument();
    }
  });

  it("has no \"See all updates\" row -- this page is already the full list", () => {
    render(<VoiceChangelogPage />);

    expect(
      screen.queryByRole("button", { name: "See all updates" }),
    ).toBeNull();
  });
});
