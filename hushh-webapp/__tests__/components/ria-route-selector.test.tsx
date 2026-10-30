/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RiaRouteSelector } from "@/components/ria/layout/ria-route-selector";

const navigation = vi.hoisted(() => ({
  begin: vi.fn(),
  pathname: "/ria/profile",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
  }),
}));

const persona = vi.hoisted(() => ({
  riaOnboardingStatus: { verification_status: "verified" } as {
    verification_status?: string;
    advisory_status?: string;
  } | null,
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    riaOnboardingStatus: persona.riaOnboardingStatus,
    loading: false,
  }),
}));

vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  useInteractionIntents: () => [],
}));

vi.mock("@/lib/morphy-ux/hooks/use-route-transition", () => ({
  beginRouteTransition: navigation.begin,
}));

describe("RiaRouteSelector", () => {
  beforeEach(() => {
    navigation.begin.mockClear();
    navigation.push.mockClear();
    navigation.replace.mockClear();
    navigation.pathname = "/ria/profile";
    persona.riaOnboardingStatus = { verification_status: "verified" };
  });

  it("does not offer Picks to someone who is not a verified RIA", () => {
    persona.riaOnboardingStatus = { verification_status: "pending" };

    render(<RiaRouteSelector />);

    expect(screen.getByRole("tab", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Clients" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Picks" })).toBeNull();
  });

  it("does not offer Picks before verification status is known", () => {
    persona.riaOnboardingStatus = null;

    render(<RiaRouteSelector />);

    expect(screen.queryByRole("tab", { name: "Picks" })).toBeNull();
  });

  it("renders the RIA primary selector with route-driven active state", () => {
    navigation.pathname = "/ria/picks";

    render(<RiaRouteSelector />);

    expect(
      screen.getByRole("tablist", { name: "RIA workspace navigation" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Clients" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Picks" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("navigates through the shared route tab contract", () => {
    render(<RiaRouteSelector />);

    fireEvent.click(screen.getByRole("tab", { name: "Clients" }));

    expect(navigation.begin).toHaveBeenCalledWith(
      "/ria/clients",
      expect.any(Function),
      "tap",
      "contextual",
      "selection",
    );
  });
});
