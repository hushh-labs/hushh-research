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

  it("animates and focuses the capability body through the shared step transition after Continue", () => {
    render(
      <CapabilityCinematicIntroGate capabilityId="finance">
        <p>Finance preferences</p>
      </CapabilityCinematicIntroGate>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const body = document.querySelector(
      '[data-capability-cinematic-body="finance"]',
    );
    expect(body).toBeTruthy();
    expect(body?.classList.contains("motion-step-enter")).toBe(true);
    expect(document.activeElement).toBe(body);
    expect(screen.getByText("Finance preferences")).toBeTruthy();
  });

  it("uses the shared prologue for AI access without promoting it to a capability", () => {
    render(
      <CapabilityCinematicIntroGate capabilityId="connections">
        <p>Connections settings</p>
      </CapabilityCinematicIntroGate>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Choose the intelligence behind your private agent.",
      }),
    ).toBeTruthy();
    const providerLane = screen.getByRole("list", { name: "AI providers" });
    expect(providerLane).toBeTruthy();
    for (const provider of ["Google Gemini", "OpenAI", "Claude", "Grok", "Meta Muse Spark"]) {
      expect(screen.getByLabelText(provider)).toBeTruthy();
    }
    expect(screen.queryByText("Connections settings")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Connections settings")).toBeTruthy();
    expect(
      window.sessionStorage.getItem(
        capabilityCinematicIntroSessionKey("connections"),
      ),
    ).toBe("1");
  });

  it("keeps the Continue action centered and full-width on compact viewports", () => {
    render(
      <CapabilityCinematicIntroGate capabilityId="finance">
        <p>Finance preferences</p>
      </CapabilityCinematicIntroGate>,
    );

    const action = screen.getByRole("button", { name: "Continue" });
    expect(action.className).toContain("w-full");
    expect(action.className).toContain("justify-center");
    expect(action.className).toContain("text-center");
  });

  it("lets the shared flow shell own viewport clearance without clipping an inner surface", () => {
    const gateSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "components/onboarding/setup/capability-cinematic-intro.tsx",
      ),
      "utf8",
    );

    expect(gateSource).toContain(
      "min-h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-scroll-bottom-pad,2rem))]",
    );
    expect(gateSource).not.toContain("overflow-hidden");
  });

  it("uses transparent, fixed provider mark cells rather than filled brand tiles", () => {
    const gateSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "components/onboarding/setup/capability-cinematic-intro.tsx",
      ),
      "utf8",
    );

    expect(gateSource).toContain("data-runtime-provider-lane");
    expect(gateSource).toContain('className="inline-flex h-12 w-12 items-center justify-center"');
    expect(gateSource).not.toContain("bg-[color:var(--app-card-surface-compact)]");
    expect(gateSource).not.toContain("shadow-[var(--shadow-xs)]");
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
      [
        "components/connections/gemini-runtime-configuration-page.tsx",
        "connections",
      ],
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
