import { render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { describe, expect, it } from "vitest";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";
import { ONE_CAPABILITIES } from "@/lib/onboarding/one-capabilities";

describe("AgentSectionIcon roster palette", () => {
  it("renders each supplied light and dark icon with vector fallbacks for the other agents", () => {
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

    const artworkById = {
      messages: "messages",
      finance: "finance",
      wallet: "wallet",
      location: "location",
      ria: "advisor",
      gmail: "mail",
      calendar: "calendar",
      pkm: "memory",
      consent: "consent",
    } as const;

    for (const [id, artwork] of Object.entries(artworkById)) {
      const icon = screen.getByTestId(`one-agent-icon-${id}`);
      expect(icon).toHaveAttribute("data-agent-icon-kind", "image");
      const images = icon.querySelectorAll("img");
      expect(images).toHaveLength(2);
      expect(images[0]).toHaveAttribute("src", `/agents-icon-set/${artwork}-light.webp`);
      expect(images[1]).toHaveAttribute("src", `/agents-icon-set/${artwork}-dark.webp`);
      expect(images[0].className).toContain("dark:hidden");
      expect(images[1].className).toContain("dark:block");
    }

    for (const id of ["email", "marketplace", "connected-systems"]) {
      const icon = screen.getByTestId(`one-agent-icon-${id}`);
      expect(icon).toHaveAttribute("data-agent-icon-kind", "svg");
      expect(icon.querySelector("svg")).toHaveAttribute("viewBox", "0 0 64 64");
    }
    expect(container.querySelectorAll("svg")).toHaveLength(4);
    expect(container.querySelectorAll("img")).toHaveLength(18);
    const files = screen.getByTestId("one-agent-icon-files").querySelector("svg");
    expect(files).toHaveAttribute("viewBox", "0 0 256 256");
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("viewBox")).toBe(svg === files ? "0 0 256 256" : "0 0 64 64");
    }
  });

  it("keeps fallback SVG paint references unique when the same agent appears twice", () => {
    const capability = ONE_CAPABILITIES.find(({ id }) => id === "email")!;
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
