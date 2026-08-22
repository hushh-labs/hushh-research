import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VoiceExamplesPage } from "@/components/profile/voice-examples-page";
import { VOICE_AGENT_EXAMPLE_GROUPS } from "@/lib/agent/voice-agent-examples";

describe("VoiceExamplesPage", () => {
  it("renders every example group and phrase", () => {
    render(<VoiceExamplesPage />);

    for (const group of VOICE_AGENT_EXAMPLE_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
      for (const example of group.examples) {
        expect(
          screen.getByText(`“${example.phrase}”`),
        ).toBeInTheDocument();
      }
    }
  });

  it("has no dead phrases -- every example maps to a real domain group", () => {
    const keys = VOICE_AGENT_EXAMPLE_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
