import { beforeEach, describe, expect, it } from "vitest";

import {
  beginNearbyPrivateReturn,
  buildNearbyCheckInResumeHref,
  buildNearbyPrivateCheckInHref,
  consumeNearbyPrivateReturn,
} from "@/lib/one-location/nearby-private-navigation";

describe("nearby private check-in navigation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("uses one opaque per-tab token for the private handoff and check-in resume", () => {
    const token = beginNearbyPrivateReturn();

    expect(buildNearbyPrivateCheckInHref(token)).toBe(
      `/one/location?action=private-check-in&source=nearby&returnToken=${token}`,
    );
    // Resume returns to check-in's own route. It used to name Your Map with
    // `?action=check-in`, a screen that withholds the check-in sheet and then
    // redirects here anyway -- so coming back from a private share rebuilt the
    // wrong map first.
    expect(buildNearbyCheckInResumeHref(token)).toBe(
      `/one/location/check-in?resume=${token}`,
    );
    expect(consumeNearbyPrivateReturn(token)).toBe(true);
    expect(consumeNearbyPrivateReturn(token)).toBe(false);
  });

  it("fails closed for a missing or unrelated resume token", () => {
    const token = beginNearbyPrivateReturn();

    expect(consumeNearbyPrivateReturn("unrelated-navigation-token")).toBe(
      false,
    );
    expect(consumeNearbyPrivateReturn(token)).toBe(true);
  });
});
