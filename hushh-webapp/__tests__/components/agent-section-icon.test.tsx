import { render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { describe, expect, it } from "vitest";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";

describe("AgentSectionIcon roster palette", () => {
  it("uses nine stable launcher colors before repeating the sequence", () => {
    const icon = lucideCapabilityIcon(Landmark);

    render(
      <>
        {Array.from({ length: 10 }, (_, paletteIndex) => (
          <AgentSectionIcon
            key={paletteIndex}
            id={`palette-${paletteIndex}`}
            icon={icon}
            tone="finance"
            paletteIndex={paletteIndex}
            treatment="profile"
          />
        ))}
      </>,
    );

    const colors = Array.from({ length: 10 }, (_, paletteIndex) =>
      screen
        .getByTestId(`one-agent-icon-palette-${paletteIndex}`)
        .style.getPropertyValue("--agent-icon-profile-bg"),
    );

    expect(new Set(colors.slice(0, 9))).toHaveLength(9);
    expect(colors[9]).toBe(colors[0]);
  });
});
