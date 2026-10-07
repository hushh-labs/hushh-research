import { render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { describe, expect, it } from "vitest";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";
import { ONE_CAPABILITIES } from "@/lib/onboarding/one-capabilities";

describe("AgentSectionIcon roster palette", () => {
  it("renders scalable vector artwork without raster images for every home agent", () => {
    const { container } = render(
      <>
        {ONE_CAPABILITIES.map((capability) => (
          <AgentSectionIcon
            key={capability.id}
            id={capability.id}
            icon={capability.icon}
            treatment="app"
            size="roster"
          />
        ))}
      </>,
    );

    expect(container.querySelectorAll("svg")).toHaveLength(ONE_CAPABILITIES.length);
    expect(container.querySelector("img, image, foreignObject")).toBeNull();
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("viewBox")).toBe("0 0 64 64");
    }
  });

  it("keeps SVG paint references unique when the same agent appears twice", () => {
    const capability = ONE_CAPABILITIES[0];
    const { container } = render(
      <>
        {["roster", "roster-lg"].map((size) => (
          <AgentSectionIcon
            key={size}
            id={capability.id}
            icon={capability.icon}
            treatment="app"
            size={size as "roster" | "roster-lg"}
          />
        ))}
      </>,
    );

    const gradients = [...container.querySelectorAll("linearGradient")];
    expect(new Set(gradients.map((gradient) => gradient.id))).toHaveLength(2);
    for (const gradient of gradients) {
      expect(gradient.closest("svg")?.querySelector(`[fill="url(#${gradient.id})"]`)).not.toBeNull();
    }
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
