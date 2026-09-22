import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decideProfileOpen,
  isOneProductPathname,
  isProfilePathname,
  openProfileFromVoice,
} from "@/lib/one-voice/profile-open";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

vi.mock("@/lib/navigation/profile-pane", () => ({
  requestProfilePaneOpen: vi.fn(),
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(() => true),
}));

describe("profile-open pathname helpers", () => {
  it("recognises Profile and its nested screens", () => {
    expect(isProfilePathname("/one/profile")).toBe(true);
    expect(isProfilePathname("/one/profile/")).toBe(true);
    expect(isProfilePathname("/one/profile/account/phone")).toBe(true);
    expect(isProfilePathname("/one/profile?panel=account")).toBe(true);
    expect(isProfilePathname("/one/location")).toBe(false);
    expect(isProfilePathname("/one/profiles")).toBe(false);
  });

  it("recognises /one product routes but never Profile", () => {
    expect(isOneProductPathname("/one")).toBe(true);
    expect(isOneProductPathname("/one/location")).toBe(true);
    expect(isOneProductPathname("/one/location?action=settings")).toBe(true);
    expect(isOneProductPathname("/one/profile")).toBe(false);
    expect(isOneProductPathname("/one/profile/account")).toBe(false);
    expect(isOneProductPathname("/login")).toBe(false);
    expect(isOneProductPathname("/")).toBe(false);
  });
});

describe("decideProfileOpen", () => {
  it("opens the pane on a /one/* product route so the conversation stays docked", () => {
    expect(decideProfileOpen({ pathname: "/one/location" })).toEqual({
      kind: "pane",
      source: "tap",
    });
    expect(
      decideProfileOpen({ pathname: "/one/location?action=share" }),
    ).toEqual({
      kind: "pane",
      source: "tap",
    });
    expect(decideProfileOpen({ pathname: "/one" })).toEqual({
      kind: "pane",
      source: "tap",
    });
  });

  it("navigates to the Profile root when already inside Profile", () => {
    expect(decideProfileOpen({ pathname: "/one/profile/account" })).toEqual({
      kind: "route",
      href: "/one/profile",
    });
    expect(decideProfileOpen({ pathname: "/one/profile" })).toEqual({
      kind: "route",
      href: "/one/profile",
    });
  });

  it("navigates to the requested detail even on a product route, carrying the origin", () => {
    expect(
      decideProfileOpen({ pathname: "/one/location", detail: "account" }),
    ).toEqual({
      kind: "route",
      href: "/one/profile/account?from=%2Fone%2Flocation",
    });
    expect(
      decideProfileOpen({ pathname: "/one/location", detail: "access" }),
    ).toEqual({
      kind: "route",
      href: "/one/profile/access?from=%2Fone%2Flocation",
    });
    expect(
      decideProfileOpen({
        pathname: "/one/location",
        detail: "preferences/voice",
      }),
    ).toEqual({
      kind: "route",
      href: "/one/profile/preferences/voice?from=%2Fone%2Flocation",
    });
  });

  it("navigates to a detail without an origin marker from inside Profile", () => {
    expect(
      decideProfileOpen({
        pathname: "/one/profile",
        detail: "preferences/voice",
      }),
    ).toEqual({
      kind: "route",
      href: "/one/profile/preferences/voice",
    });
  });

  it("honours an explicit presentation", () => {
    expect(
      decideProfileOpen({ pathname: "/one/location", presentation: "route" }),
    ).toEqual({
      kind: "route",
      href: "/one/profile?from=%2Fone%2Flocation",
    });
    // A pane request from outside /one still opens the pane; the shell owns
    // whether it can present one there.
    expect(decideProfileOpen({ pathname: "/", presentation: "pane" })).toEqual({
      kind: "pane",
      source: "tap",
    });
  });

  it("falls back to the route outside the product shell", () => {
    expect(decideProfileOpen({ pathname: "/" })).toEqual({
      kind: "route",
      href: "/one/profile",
    });
    expect(decideProfileOpen({ pathname: "" })).toEqual({
      kind: "route",
      href: "/one/profile",
    });
  });

  it("a requested detail always wins over the pane, even when asked for", () => {
    expect(
      decideProfileOpen({
        pathname: "/one/location",
        presentation: "pane",
        detail: "account",
      }).kind,
    ).toBe("route");
  });
});

describe("openProfileFromVoice", () => {
  beforeEach(() => {
    vi.mocked(requestProfilePaneOpen).mockClear();
    vi.mocked(requestInternalAppNavigation).mockClear();
  });

  it("asks the shell for the pane on a product route", () => {
    const decision = openProfileFromVoice({ pathname: "/one/location" });
    expect(decision).toEqual({ kind: "pane", source: "tap" });
    expect(requestProfilePaneOpen).toHaveBeenCalledWith("tap");
    expect(requestInternalAppNavigation).not.toHaveBeenCalled();
  });

  it("navigates as a voice-sourced internal request for a detail", () => {
    const decision = openProfileFromVoice({
      pathname: "/one/location",
      detail: "preferences/voice",
    });
    expect(decision).toEqual({
      kind: "route",
      href: "/one/profile/preferences/voice?from=%2Fone%2Flocation",
    });
    expect(requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/profile/preferences/voice?from=%2Fone%2Flocation",
      source: "voice",
      transitionMode: "contextual",
    });
    expect(requestProfilePaneOpen).not.toHaveBeenCalled();
  });

  it("navigates instead of re-opening the pane while already in Profile", () => {
    openProfileFromVoice({ pathname: "/one/profile/security" });
    expect(requestInternalAppNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ href: "/one/profile", source: "voice" }),
    );
    expect(requestProfilePaneOpen).not.toHaveBeenCalled();
  });
});
