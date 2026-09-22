import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONE_VOICE_FOCUS_PENDING_EVENT,
  ONE_VOICE_REFRESH_EVENT,
  executeDirective,
  isSafeInternalHref,
  isScreenOwnedDirective,
  resolveNavigateTarget,
  type OneVoiceFocusPendingDetail,
  type OneVoiceRefreshDetail,
} from "@/lib/one-voice/directives";
import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

vi.mock("@/lib/navigation/profile-pane", () => ({
  requestProfilePaneOpen: vi.fn(),
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(() => true),
}));

const LOCATION = "/one/location";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveNavigateTarget", () => {
  it("resolves a wired route action to its href", () => {
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_settings" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/location?action=settings",
    });
  });

  it("appends circle and person ids only on Location routes, and only canonical ids", () => {
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_circles", circle_id: "circle-42" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/location?view=circles&circle=circle-42",
    });
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_people", user_id: "user_7" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/location?view=people&person=user_7",
    });
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_people", user_id: "../etc?x=1" },
        LOCATION,
      ),
    ).toEqual({ kind: "route", href: "/one/location?view=people" });
    // Entity ids never ride along to a non-Location route.
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "vault.setup_open", circle_id: "c-1" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/setup",
    });
  });

  it("opens Profile as the pane on a /one/* product route, else navigates", () => {
    expect(
      resolveNavigateTarget({ gateway_action_id: "route.profile" }, LOCATION),
    ).toEqual({ kind: "profile_pane" });
    expect(
      resolveNavigateTarget({ gateway_action_id: "route.profile" }, "/login"),
    ).toEqual({
      kind: "route",
      href: "/one/profile",
    });
    expect(
      resolveNavigateTarget({ gateway_action_id: "route.profile" }, null),
    ).toEqual({
      kind: "route",
      href: "/one/profile",
    });
  });

  it("refuses unknown, missing and voice_tool actions", () => {
    expect(resolveNavigateTarget({}, LOCATION)).toBeNull();
    expect(
      resolveNavigateTarget({ gateway_action_id: "nope.nothing" }, LOCATION),
    ).toBeNull();
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.setup.accept_consent" },
        LOCATION,
      ),
    ).toBeNull();
  });

  it("only internal product hrefs are safe; a route outside /one is refused", () => {
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "route.getting_started" },
        LOCATION,
      ),
    ).toBeNull();
    expect(isSafeInternalHref("/one/location?view=people")).toBe(true);
    expect(isSafeInternalHref("/one")).toBe(true);
    expect(isSafeInternalHref("//evil.example/one")).toBe(false);
    expect(isSafeInternalHref("https://evil.example/one")).toBe(false);
    expect(isSafeInternalHref("/login")).toBe(false);
  });
});

describe("executeDirective", () => {
  it("navigate dispatches the internal navigation request and settles opened", async () => {
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "location.open_circles", circle_id: "circle-1" },
      { pathname: LOCATION },
    );
    expect(outcome).toEqual({ handled: true, status: "opened" });
    expect(requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/location?view=circles&circle=circle-1",
      source: "voice",
      transitionMode: "contextual",
    });
  });

  it("navigate to Profile opens the pane on a product route", async () => {
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.profile" },
      { pathname: LOCATION },
    );
    expect(outcome.status).toBe("opened");
    expect(requestProfilePaneOpen).toHaveBeenCalledWith("tap");
    expect(requestInternalAppNavigation).not.toHaveBeenCalled();
  });

  it("navigate fails cleanly for an unknown action", async () => {
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "ghost" },
      { pathname: LOCATION },
    );
    expect(outcome).toEqual({
      handled: true,
      status: "failed",
      reason: "unknown_route",
    });
  });

  it("focus_pending_action dispatches the focus event with the id", async () => {
    const received: OneVoiceFocusPendingDetail[] = [];
    const listener = (event: Event) =>
      received.push((event as CustomEvent<OneVoiceFocusPendingDetail>).detail);
    window.addEventListener(ONE_VOICE_FOCUS_PENDING_EVENT, listener);
    try {
      const outcome = await executeDirective(
        "focus_pending_action",
        { pending_action_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        { pathname: LOCATION },
      );
      expect(outcome.status).toBe("opened");
      expect(received).toEqual([
        { pendingActionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      ]);
    } finally {
      window.removeEventListener(ONE_VOICE_FOCUS_PENDING_EVENT, listener);
    }
  });

  it("refresh dispatches the refresh event with the bounded ui_refresh list", async () => {
    const received: OneVoiceRefreshDetail[] = [];
    const listener = (event: Event) =>
      received.push((event as CustomEvent<OneVoiceRefreshDetail>).detail);
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, listener);
    try {
      const outcome = await executeDirective(
        "refresh",
        { ui_refresh: ["location_status", " circles ", 42, ""] },
        { pathname: LOCATION },
      );
      expect(outcome.status).toBe("opened");
      expect(received).toEqual([{ uiRefresh: ["location_status", "circles"] }]);
    } finally {
      window.removeEventListener(ONE_VOICE_REFRESH_EVENT, listener);
    }
  });

  it("open_share_sheet uses the native share when available", async () => {
    const share = vi.fn(async () => true);
    const outcome = await executeDirective(
      "open_share_sheet",
      {
        url: "https://hushh.ai/l/abc",
        text: "Join my circle",
        title: "Family",
      },
      { pathname: LOCATION, share },
    );
    expect(outcome).toEqual({ handled: true, status: "opened" });
    expect(share).toHaveBeenCalledWith({
      url: "https://hushh.ai/l/abc",
      text: "Join my circle",
      title: "Family",
    });
  });

  it("open_share_sheet falls back to copy plus a toast; a dismissed sheet is ignored", async () => {
    const copyText = vi.fn(async () => true);
    const notify = vi.fn();
    const outcome = await executeDirective(
      "open_share_sheet",
      { url: "https://hushh.ai/l/abc" },
      { pathname: LOCATION, share: async () => false, copyText, notify },
    );
    expect(outcome).toEqual({
      handled: true,
      status: "opened",
      reason: "copied",
    });
    expect(copyText).toHaveBeenCalledWith("https://hushh.ai/l/abc");
    expect(notify).toHaveBeenCalledWith("Link copied");

    const dismissed = await executeDirective(
      "open_share_sheet",
      { text: "hello" },
      {
        pathname: LOCATION,
        share: async () => {
          throw new DOMException("dismissed", "AbortError");
        },
        copyText,
      },
    );
    expect(dismissed.status).toBe("ignored");

    const empty = await executeDirective(
      "open_share_sheet",
      {},
      { pathname: LOCATION },
    );
    expect(empty).toEqual({
      handled: true,
      status: "failed",
      reason: "nothing_to_share",
    });
  });

  it("leaves the Location-owned kinds to the screens", async () => {
    expect(isScreenOwnedDirective("publish_location_envelopes")).toBe(true);
    expect(isScreenOwnedDirective("request_os_permission")).toBe(true);
    expect(isScreenOwnedDirective("navigate")).toBe(false);
    for (const kind of [
      "publish_location_envelopes",
      "request_os_permission",
    ]) {
      const outcome = await executeDirective(
        kind,
        { any: "thing" },
        { pathname: LOCATION },
      );
      expect(outcome.handled).toBe(false);
      expect(outcome.status).toBe("ignored");
    }
    expect(requestInternalAppNavigation).not.toHaveBeenCalled();
  });

  it("an unknown kind is not handled", async () => {
    const outcome = await executeDirective(
      "teleport",
      {},
      { pathname: LOCATION },
    );
    expect(outcome.handled).toBe(false);
  });
});
