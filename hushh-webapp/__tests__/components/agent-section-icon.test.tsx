import { render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { describe, expect, it } from "vitest";

import { AgentIdentityIcon, AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";

describe("AgentSectionIcon roster palette", () => {
  it.each([
    ["email", "/agents/kyc.png"],
    ["consent", "/agents/consent.png"],
  ])("renders %s artwork without an extra background", (id, src) => {
    render(<AgentIdentityIcon id={id} size="roster-dashboard" />);
    const icon = screen.getByTestId(`one-agent-icon-${id}`);
    expect(icon).toHaveAttribute("data-agent-icon-kind", "image");
    expect(icon.className).toContain("h-14 w-14");
    expect(icon.className).not.toContain("bg-");
    expect(icon.querySelector("img")).toHaveAttribute("src", src);
  });
  it("uses supplied artwork without a painted background at existing header dimensions", () => {
    render(<AgentIdentityIcon id="location" />);
    const icon = screen.getByTestId("one-agent-icon-location");
    expect(icon).toHaveAttribute("data-agent-icon-kind", "image");
    expect(icon.className).toContain("h-11 w-11");
    expect(icon.className).not.toContain("bg-");
    expect(icon.getAttribute("style")).toBeNull();
    expect(icon.querySelector("img")).toHaveAttribute("src", "/agents/location.png");
  });
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
