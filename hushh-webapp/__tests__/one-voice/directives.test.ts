import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NAVIGATE_SETTLE_TIMEOUT_MS,
  ONE_VOICE_FOCUS_PENDING_EVENT,
  ONE_VOICE_REFRESH_EVENT,
  defaultObserveNavigation,
  executeDirective,
  isSafeInternalHref,
  isScreenOwnedDirective,
  resolveNavigateTarget,
  type NavigateObservation,
  type OneVoiceFocusPendingDetail,
  type OneVoiceRefreshDetail,
} from "@/lib/one-voice/directives";
import {
  PROFILE_PANE_SHOWN_EVENT,
  requestProfilePaneOpen,
  resolveProfilePaneUrlState,
} from "@/lib/navigation/profile-pane";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

vi.mock("@/lib/navigation/profile-pane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/navigation/profile-pane")>()),
  requestProfilePaneOpen: vi.fn(() => null),
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(() => true),
}));

const LOCATION = "/one/location";
const PERSON_REF = "6f1c2a4e-9b3d-4c7a-8e21-0d5f4b9a7c13";

/** An injected observer that records what it was asked to watch. */
function observer(seen: boolean) {
  const watched: NavigateObservation[] = [];
  const observeNavigation = vi.fn(
    async (target: NavigateObservation, timeoutMs: number) => {
      watched.push(target);
      expect(timeoutMs).toBe(NAVIGATE_SETTLE_TIMEOUT_MS);
      return seen;
    },
  );
  return { watched, observeNavigation };
}

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
      observe: { kind: "path", path: LOCATION, search: "?action=settings" },
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
      observe: { kind: "path", path: LOCATION, search: "?view=circles&circle=circle-42" },
    });
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_people", user_id: "user_7" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/location?view=people&person=user_7",
      observe: { kind: "path", path: LOCATION, search: "?view=people&person=user_7" },
    });
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "location.open_people", user_id: "../etc?x=1" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/location?view=people",
      observe: { kind: "path", path: LOCATION, search: "?view=people" },
    });
    // Entity ids never ride along to a non-Location route.
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "vault.setup_open", circle_id: "c-1" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/setup",
      observe: { kind: "path", path: "/one/setup" },
    });
  });

  it("docks the Profile pane over the current screen; inside Profile it routes", () => {
    for (const pathname of [LOCATION, "/", null]) {
      expect(
        resolveNavigateTarget({ gateway_action_id: "route.profile" }, pathname),
      ).toEqual({ kind: "profile_pane" });
    }
    // The owner's Profile never reads a person id: another person's profile
    // is its own action (route.person_profile).
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "route.profile", user_id: "user_7" },
        LOCATION,
      ),
    ).toEqual({ kind: "profile_pane" });
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "route.profile" },
        "/one/profile/security",
      ),
    ).toEqual({
      kind: "route",
      href: "/one/profile",
      observe: { kind: "profile_pane" },
    });
  });

  it("opens Privacy at the canonical Sharing pane location", () => {
    for (const actionId of ["route.profile_privacy", "route.profile_access_panel"]) {
      const privacy = resolveNavigateTarget(
        { gateway_action_id: actionId },
        LOCATION,
      );
      expect(privacy).toEqual({
        kind: "route",
        href: "/one?from=%2Fone%2Flocation&profile_pane=1&profile_panel=my-data&profile_detail=sharing",
        observe: {
          kind: "profile_route",
          path: "/one/profile/access",
          paneKey: "my-data:sharing",
        },
      });
      if (!privacy || privacy.kind !== "route") throw new Error("Privacy must have a route");
      expect(resolveProfilePaneUrlState(new URL(privacy.href, "https://one.test").search))
        .toEqual({ open: true, location: { panel: "my-data", detail: "sharing" } });
    }
  });

  it("resolves Voice settings to a Profile route observed at its detail", () => {
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "route.voice_settings" },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: "/one/profile/preferences/voice?from=%2Fone%2Flocation",
      observe: expect.objectContaining({
        kind: "profile_route",
        path: "/one/profile/preferences/voice",
      }),
    });
  });

  it("opens another person's profile only from a UUID public_person_ref", () => {
    expect(
      resolveNavigateTarget(
        {
          gateway_action_id: "route.person_profile",
          screen: "person_profile",
          user_id: "user_7",
          public_person_ref: PERSON_REF,
          circle_id: null,
        },
        LOCATION,
      ),
    ).toEqual({
      kind: "route",
      href: `/people/${PERSON_REF}?from=%2Fone%2Flocation`,
      observe: { kind: "path", path: `/people/${PERSON_REF}` },
    });
    // Missing or non-UUID refs fail closed: never the owner, never a template.
    for (const ref of [undefined, "", "ppr-ayesha", "../one/profile", 42]) {
      expect(
        resolveNavigateTarget(
          { gateway_action_id: "route.person_profile", public_person_ref: ref },
          LOCATION,
        ),
      ).toBeNull();
    }
  });

  it("never navigates to a literal route template", () => {
    expect(
      resolveNavigateTarget(
        { gateway_action_id: "route.ria_client_workspace", user_id: "user_7" },
        LOCATION,
      ),
    ).toBeNull();
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

describe("defaultObserveNavigation", () => {
  it("sees a Profile screen the web proxy redirected into the pane at that location", async () => {
    // proxy.ts sends /one/profile/preferences/voice to the pane on /one.
    const target = resolveNavigateTarget(
      { gateway_action_id: "route.voice_settings" },
      LOCATION,
    );
    if (!target || target.kind !== "route" || !target.observe) {
      throw new Error("voice settings must resolve to an observed route");
    }
    const seen = defaultObserveNavigation(
      target.observe,
      5_000,
      new AbortController().signal,
    );
    window.history.pushState(
      null,
      "",
      "/one?profile_pane=1&profile_panel=preferences&profile_detail=voice",
    );
    await expect(seen).resolves.toBe(true);

    // Negative control: the pane open somewhere else is not that screen.
    window.history.replaceState(
      null,
      "",
      "/one?profile_pane=1&profile_panel=security",
    );
    await expect(
      defaultObserveNavigation(target.observe, 300, new AbortController().signal),
    ).resolves.toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("does not settle Privacy from a shown event for another Profile pane location", async () => {
    const target = resolveNavigateTarget(
      { gateway_action_id: "route.profile_privacy" },
      LOCATION,
    );
    if (!target || target.kind !== "route" || !target.observe) {
      throw new Error("Privacy must resolve to an observed pane location");
    }
    window.history.replaceState(
      null, "", "/one?profile_pane=1&profile_panel=security",
    );
    const abort = new AbortController();
    const wrong = defaultObserveNavigation(target.observe, 5_000, abort.signal);
    window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
    abort.abort();
    await expect(wrong).resolves.toBe(false);

    window.history.replaceState(null, "", target.href);
    const correct = defaultObserveNavigation(
      target.observe, 5_000, new AbortController().signal,
    );
    window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
    await expect(correct).resolves.toBe(true);
    window.history.replaceState(null, "", "/");
  });

  it("sees the pane-shown event and the target path; timeout and abort read as not shown", async () => {
    const pane = defaultObserveNavigation(
      { kind: "profile_pane" },
      5_000,
      new AbortController().signal,
    );
    window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
    await expect(pane).resolves.toBe(true);

    const path = defaultObserveNavigation(
      { kind: "path", path: `/people/${PERSON_REF}` },
      5_000,
      new AbortController().signal,
    );
    window.history.pushState(null, "", `/people/${PERSON_REF}/?from=%2Fone`);
    await expect(path).resolves.toBe(true);
    window.history.replaceState(null, "", "/");

    await expect(
      defaultObserveNavigation({ kind: "profile_pane" }, 10, new AbortController().signal),
    ).resolves.toBe(false);

    const controller = new AbortController();
    const aborted = defaultObserveNavigation(
      { kind: "profile_pane" },
      5_000,
      controller.signal,
    );
    controller.abort();
    // A late shown event after the abort cannot flip the answer.
    window.dispatchEvent(new CustomEvent(PROFILE_PANE_SHOWN_EVENT));
    await expect(aborted).resolves.toBe(false);
  });

  it("requires the requested Location view and person, not just its pathname", async () => {
    const target = {
      kind: "path" as const,
      path: LOCATION,
      search: "?view=people&person=user_7",
    };
    window.history.replaceState(null, "", "/one/location?view=people&person=other");
    await expect(
      defaultObserveNavigation(target, 150, new AbortController().signal),
    ).resolves.toBe(false);

    const seen = defaultObserveNavigation(target, 5_000, new AbortController().signal);
    window.history.replaceState(
      null, "", "/one/location?person=user_7&view=people&other=kept",
    );
    await expect(seen).resolves.toBe(true);
    window.history.replaceState(null, "", "/");
  });
});

describe("executeDirective", () => {
  it("generic navigate settles opened only after the requested route state is observed", async () => {
    const { watched, observeNavigation } = observer(true);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "location.open_circles", circle_id: "circle-1" },
      { pathname: LOCATION, observeNavigation },
    );
    expect(outcome).toEqual({ handled: true, status: "opened" });
    expect(watched).toEqual([{
      kind: "path", path: LOCATION, search: "?view=circles&circle=circle-1",
    }]);
    expect(requestInternalAppNavigation).toHaveBeenCalledWith({
      href: "/one/location?view=circles&circle=circle-1",
      source: "voice",
      transitionMode: "contextual",
    });
  });

  it("generic navigate fails when dispatch succeeds but its query state never shows", async () => {
    window.history.replaceState(null, "", "/one/location?view=people&person=other");
    try {
      const navigate = vi.fn(() => true);
      const { watched, observeNavigation } = observer(false);
      const outcome = await executeDirective(
        "navigate",
        { gateway_action_id: "location.open_people", user_id: "user_7" },
        { pathname: LOCATION, navigate, observeNavigation },
      );
      expect(navigate).toHaveBeenCalledWith("/one/location?view=people&person=user_7");
      expect(watched).toEqual([{
        kind: "path", path: LOCATION, search: "?view=people&person=user_7",
      }]);
      expect(outcome).toEqual({ handled: true, status: "failed", reason: "not_shown" });
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("navigate to Profile opens the pane and settles opened only once it shows", async () => {
    const { watched, observeNavigation } = observer(true);
    const openProfilePane = vi.fn(() => "opening" as const);
    const navigate = vi.fn(() => true);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.profile" },
      { pathname: LOCATION, openProfilePane, observeNavigation, navigate },
    );
    expect(outcome).toEqual({ handled: true, status: "opened" });
    expect(watched).toEqual([{ kind: "profile_pane" }]);
    expect(openProfilePane).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a pane the shell accepted but never showed settles failed, not opened", async () => {
    // Regression: this used to report "opened" on dispatch, so One said
    // "I've opened your profile" while nothing was on screen.
    const { observeNavigation } = observer(false);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.profile" },
      {
        pathname: LOCATION,
        openProfilePane: () => "opening",
        observeNavigation,
        navigate: () => true,
      },
    );
    expect(outcome).toEqual({
      handled: true,
      status: "failed",
      reason: "not_shown",
    });
  });

  it("an already-open pane settles opened without navigating", async () => {
    const navigate = vi.fn(() => true);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.profile" },
      {
        pathname: LOCATION,
        openProfilePane: () => "already_open",
        observeNavigation: observer(false).observeNavigation,
        navigate,
      },
    );
    expect(outcome).toEqual({
      handled: true,
      status: "opened",
      reason: "already_open",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a refused pane falls back to the Profile route and settles on what showed", async () => {
    for (const answer of ["unavailable", null] as const) {
      const shown = observer(true);
      const navigate = vi.fn(() => true);
      const opened = await executeDirective(
        "navigate",
        { gateway_action_id: "route.profile" },
        {
          pathname: "/one/location/check-in",
          openProfilePane: () => answer,
          observeNavigation: shown.observeNavigation,
          navigate,
        },
      );
      expect(opened).toEqual({
        handled: true,
        status: "opened",
        reason: "pane_unavailable",
      });
      expect(navigate).toHaveBeenCalledWith("/one/profile");
      expect(shown.watched.at(-1)).toEqual({ kind: "profile_pane" });
    }
    const failed = await executeDirective(
      "navigate",
      { gateway_action_id: "route.profile" },
      {
        pathname: LOCATION,
        openProfilePane: () => "unavailable",
        observeNavigation: observer(false).observeNavigation,
        navigate: () => true,
      },
    );
    expect(failed).toEqual({
      handled: true,
      status: "failed",
      reason: "not_shown",
    });
  });

  it("navigate to another person's profile settles on the /people path", async () => {
    const { watched, observeNavigation } = observer(true);
    const navigate = vi.fn(() => true);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.person_profile", public_person_ref: PERSON_REF },
      { pathname: LOCATION, observeNavigation, navigate },
    );
    expect(outcome).toEqual({ handled: true, status: "opened" });
    expect(navigate).toHaveBeenCalledWith(
      `/people/${PERSON_REF}?from=%2Fone%2Flocation`,
    );
    expect(watched).toEqual([{ kind: "path", path: `/people/${PERSON_REF}` }]);
    expect(requestProfilePaneOpen).not.toHaveBeenCalled();

    const missing = await executeDirective(
      "navigate",
      { gateway_action_id: "route.person_profile", user_id: "user_7" },
      { pathname: LOCATION, observeNavigation, navigate },
    );
    expect(missing).toEqual({
      handled: true,
      status: "failed",
      reason: "unknown_route",
    });
    expect(requestProfilePaneOpen).not.toHaveBeenCalled();
  });

  it("a Profile detail already on screen settles opened without navigating", async () => {
    const navigate = vi.fn(() => true);
    const outcome = await executeDirective(
      "navigate",
      { gateway_action_id: "route.voice_settings" },
      {
        pathname: "/one/profile/preferences/voice/",
        observeNavigation: observer(false).observeNavigation,
        navigate,
      },
    );
    expect(outcome).toEqual({
      handled: true,
      status: "opened",
      reason: "already_shown",
    });
    expect(navigate).not.toHaveBeenCalled();
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
