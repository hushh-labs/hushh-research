import fs from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityCinematicIntroGate,
  capabilityCinematicIntroSessionKey,
} from "@/components/onboarding/setup/capability-cinematic-intro";

describe("CapabilityCinematicIntroGate", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("presents the finance premise before the capability body and latches only for this session", () => {
    render(
      <CapabilityCinematicIntroGate capabilityId="finance">
        <p>Finance preferences</p>
      </CapabilityCinematicIntroGate>,
    );

    expect(
      screen.getByRole("heading", {
        name: "A clearer way to understand your money.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Finance preferences")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Finance preferences")).toBeTruthy();
    expect(
      window.sessionStorage.getItem(
        capabilityCinematicIntroSessionKey("finance"),
      ),
    ).toBe("1");
    expect(
      window.localStorage.getItem(
        capabilityCinematicIntroSessionKey("finance"),
      ),
    ).toBeNull();
  });

  it("does not replay a seen capability intro after an OAuth-style route return", async () => {
    window.sessionStorage.setItem(
      capabilityCinematicIntroSessionKey("gmail"),
      "1",
    );

    render(
      <CapabilityCinematicIntroGate capabilityId="gmail">
        <p>Gmail connection</p>
      </CapabilityCinematicIntroGate>,
    );

    await waitFor(() => {
      expect(screen.getByText("Gmail connection")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("uses the shared visual-only step reveal with reduced-motion coverage", () => {
    render(
      <CapabilityCinematicIntroGate capabilityId="location">
        <p>Location body</p>
      </CapabilityCinematicIntroGate>,
    );

    expect(document.querySelector(".motion-step-enter")).toBeTruthy();
    const globalStyles = fs.readFileSync(
      path.resolve(process.cwd(), "app/globals.css"),
      "utf8",
    );
    expect(globalStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalStyles).toMatch(
      /\.motion-step-enter\s*\{\s*animation:\s*none !important;/m,
    );
  });

  it("keeps every authored setup journey on the shared, non-durable gate", () => {
    const surfaces = [
      ["app/one/setup/kai/page.tsx", "finance"],
      ["app/ria/onboarding/page.tsx", "ria"],
      ["components/onboarding/setup/kyc-identity-preface.tsx", "email"],
      [
        "app/one/setup/connected-systems/connected-systems-onboarding-setup-client.tsx",
        "connected-systems",
      ],
      [
        "app/one/setup/location/location-onboarding-setup-client.tsx",
        "location",
      ],
      ["app/one/setup/gmail/gmail-onboarding-setup-client.tsx", "gmail"],
    ] as const;

    for (const [relativePath, capabilityId] of surfaces) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), relativePath),
        "utf8",
      );
      expect(source).toContain(
        `<CapabilityCinematicIntroGate capabilityId="${capabilityId}"`,
      );
    }

    const gateSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "components/onboarding/setup/capability-cinematic-intro.tsx",
      ),
      "utf8",
    );
    expect(gateSource).toContain("window.sessionStorage");
    expect(gateSource).not.toContain("window.localStorage");
  });
});
