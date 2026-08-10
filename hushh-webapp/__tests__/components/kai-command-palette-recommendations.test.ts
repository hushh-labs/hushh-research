import { describe, expect, it } from "vitest";

import {
  actionTargetsCurrentSurface,
  buildInitialCommandRecommendations,
} from "@/components/kai/kai-command-palette";
import {
  getKaiActionById,
  listKaiActionsForSurface,
} from "@/lib/voice/kai-action-gateway";

describe("the palette's on-screen action group", () => {
  it("offers the surface its own contract declares, not the market list", () => {
    // The reported problem was search showing Kai and Finance entries whatever
    // screen it was opened on. Location declares its whole surface, so it is
    // the honest check that the group follows the person rather than the app.
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

    // Bare Location: "Open Location now" would be a suggestion to stay put.
    expect(actionTargetsCurrentSurface(openNow!, "/one/location", null)).toBe(
      true,
    );
    expect(
      actionTargetsCurrentSurface(openPeople!, "/one/location", null),
    ).toBe(false);

    // On the People tab the roles swap, read off the same subview the voice
    // route derivation reports.
    expect(
      actionTargetsCurrentSurface(openPeople!, "/one/location", "people"),
    ).toBe(true);
    expect(actionTargetsCurrentSurface(openNow!, "/one/location", "people")).toBe(
      false,
    );
  });

  it("never mistakes a local handler for a destination", () => {
    const refresh = getKaiActionById("location.refresh");
    expect(refresh?.execution_target).toMatchObject({ path: "local_handler" });
    expect(actionTargetsCurrentSurface(refresh!, "/one/location", null)).toBe(
      false,
    );
  });
});

describe("initial command-palette recommendations", () => {
  it("puts the cached One top mover first and preserves its analysis slot", () => {
    const recommendations = buildInitialCommandRecommendations({
      topMover: { symbol: "nvda", companyName: "NVIDIA" },
    });

    expect(recommendations[0]).toEqual({
      actionId: "analysis.start",
      category: "Research",
      label: "Analyze NVDA · NVIDIA",
      slots: { symbol: "NVDA" },
    });
  });

  it("keeps the first viewport short and varied when market data is unavailable", () => {
    const recommendations = buildInitialCommandRecommendations({ topMover: null });

    expect(recommendations).toHaveLength(4);
    expect(recommendations.map((item) => item.category)).toEqual([
      "Research",
      "Memory",
      "Consent",
      "Account",
    ]);
    expect(recommendations[0]).toMatchObject({
      actionId: "analysis.start",
      label: "Start stock analysis",
    });
  });
});
