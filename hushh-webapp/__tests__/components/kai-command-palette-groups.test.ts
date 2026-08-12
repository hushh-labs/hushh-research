// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  actionTargetsCurrentSurface,
  isLocalHandlerAwayFromItsScreen,
  navigationActionForAction,
  readTappableControlIds,
} from "@/components/kai/kai-command-palette";
import {
  getKaiActionById,
  listKaiActionsForSurface,
} from "@/lib/voice/kai-action-gateway";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("what the palette offers on a screen", () => {
  it("draws from the surface's own contract, not the market list", () => {
    // The reported problem was search offering stock analysis and Memory
    // whatever screen it was opened on. Location declares its whole surface,
    // so it is the honest check that the list follows the person.
    const labels = listKaiActionsForSurface({
      screen: "one_location",
      pathname: "/one/location",
    }).map((action) => action.label);

    expect(labels).toContain("Share my location");
    expect(labels).toContain("Open emergency SOS");
    expect(labels).toContain("Create a circle");
    expect(labels).not.toContain("Start stock analysis");
  });

  it("drops the action that leads where the person already stands", () => {
    const openNow = getKaiActionById("location.open_now");
    const openPeople = getKaiActionById("location.open_people");
    expect(openNow).toBeTruthy();
    expect(openPeople).toBeTruthy();

    expect(actionTargetsCurrentSurface(openNow!, "/one/location", null)).toBe(
      true,
    );
    expect(actionTargetsCurrentSurface(openPeople!, "/one/location", null)).toBe(
      false,
    );

    // On the People tab the roles swap, read off the same subview the voice
    // route derivation reports.
    expect(
      actionTargetsCurrentSurface(openPeople!, "/one/location", "people"),
    ).toBe(true);
    expect(
      actionTargetsCurrentSurface(openNow!, "/one/location", "people"),
    ).toBe(false);
  });

  it("never mistakes a local handler for a destination", () => {
    const refresh = getKaiActionById("location.refresh");
    expect(refresh?.execution_target).toMatchObject({ path: "local_handler" });
    expect(actionTargetsCurrentSurface(refresh!, "/one/location", null)).toBe(
      false,
    );
  });
});

describe("which controls the person can already tap", () => {
  it("reads the anchors surfaces put on their own buttons", () => {
    // This is the split between the two unfiltered groups: an action with a
    // button in front of the person belongs under Suggested actions, and one
    // without belongs in the group of things this view cannot reach.
    document.body.innerHTML = `
      <button data-voice-control-id="one-location-action-share">Share</button>
      <button data-voice-control-id="one-location-action-sos">SOS</button>
    `;

    const tappable = readTappableControlIds();
    expect(tappable.has("one-location-action-share")).toBe(true);
    expect(tappable.has("one-location-action-sos")).toBe(true);
    expect(tappable.has("one-location-action-join-circle")).toBe(false);
  });

  it("treats a control that cannot be pressed as not tappable", () => {
    // The button is on screen but inert, so the palette row is the only way
    // through and must not be filtered out as "already reachable".
    document.body.innerHTML = `
      <button data-voice-control-id="one-location-refresh" disabled>Refresh</button>
      <button data-voice-control-id="one-location-action-share" aria-disabled="true">Share</button>
    `;

    const tappable = readTappableControlIds();
    expect(tappable.has("one-location-refresh")).toBe(false);
    expect(tappable.has("one-location-action-share")).toBe(false);
  });
});

describe("commands that cannot run from here", () => {
  it("drops a local handler belonging to another screen", () => {
    // These three sat in the results doing nothing. They answer the Finance
    // risk questionnaire and only run while /one/setup/finance is mounted; the
    // runtime returns `blocked`, which the palette never surfaced.
    for (const actionId of [
      "kai.setup.answer_horizon",
      "kai.setup.answer_drawdown",
      "kai.setup.answer_volatility",
    ]) {
      const action = getKaiActionById(actionId);
      expect(action, actionId).toBeTruthy();
      expect(action!.reachability.screens).toContain("one_setup_finance");
      expect(isLocalHandlerAwayFromItsScreen(action!, "one_location")).toBe(
        true,
      );
      // On its own screen it is exactly the right thing to offer.
      expect(isLocalHandlerAwayFromItsScreen(action!, "one_setup_finance")).toBe(
        false,
      );
    }
  });

  it("keeps navigation offerable from anywhere", () => {
    // A route action carries the person to where it belongs, so standing
    // somewhere else is not a reason to hide it.
    const joinCircle = getKaiActionById("location.open_join_circle");
    expect(joinCircle?.execution_target).toMatchObject({ path: "route" });
    expect(isLocalHandlerAwayFromItsScreen(joinCircle!, "kai_market")).toBe(
      false,
    );
  });
});

describe("reaching another screen's work by typing", () => {
  it("finds the action that opens the screen a local handler lives on", () => {
    // Typing searches the whole app, so these stay in the results -- but they
    // only run on /one/setup/finance. `setup.open_finance` navigates there, so
    // selecting the row can take the person to it instead of doing nothing.
    const answer = getKaiActionById("kai.setup.answer_horizon");
    expect(answer).toBeTruthy();
    expect(answer!.reachability.routes).toContain("/one/setup/finance");
    expect(navigationActionForAction(answer!)).toBe("setup.open_finance");
  });

  it("resolves an escort without needing a route-prefixed name", () => {
    // The resolver used to require the `route.` prefix, which made whole
    // destinations look unreachable: nothing named `route.*` opens
    // /one/setup/finance, and Connect is opened by route.one_connect alone.
    const connect = getKaiActionById("route.one_connect");
    expect(connect?.execution_target).toMatchObject({
      path: "route",
      target: "/one/connect",
    });
  });

  it("does not send a navigation action off to escort itself", () => {
    const joinCircle = getKaiActionById("location.open_join_circle");
    expect(isLocalHandlerAwayFromItsScreen(joinCircle!, "kai_market")).toBe(
      false,
    );
  });
});
