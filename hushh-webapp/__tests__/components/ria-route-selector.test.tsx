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
      "full",
    );
  });
});
