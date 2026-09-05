import { beforeEach, describe, expect, it } from "vitest";

import {
  clearTabSwitchHistory,
  readPreviousTabHref,
  recordTabSelection,
} from "@/lib/navigation/tab-switch-history";

describe("tab-switch-history", () => {
  beforeEach(() => {
    clearTabSwitchHistory();
  });

  it("records nothing on a fresh arrival", () => {
    recordTabSelection("ria", "/ria/profile");
    expect(readPreviousTabHref("ria")).toBeNull();
  });

  it("records the outgoing tab once a real switch happens", () => {
    recordTabSelection("ria", "/ria/profile");
    recordTabSelection("ria", "/ria/picks");
    expect(readPreviousTabHref("ria")).toBe("/ria/profile");
  });

  it("keeps only the most recent prior tab, overwriting on the next switch", () => {
    recordTabSelection("ria", "/ria/profile");
    recordTabSelection("ria", "/ria/picks");
    recordTabSelection("ria", "/ria/clients");
    expect(readPreviousTabHref("ria")).toBe("/ria/picks");
  });

  it("does not record a same-href re-selection as a switch", () => {
    recordTabSelection("ria", "/ria/profile");
    recordTabSelection("ria", "/ria/picks");
    recordTabSelection("ria", "/ria/picks");
    expect(readPreviousTabHref("ria")).toBe("/ria/profile");
  });

  it("keeps tab sets independent of one another", () => {
    recordTabSelection("ria", "/ria/profile");
    recordTabSelection("ria", "/ria/picks");
    recordTabSelection("location", "/one/location");
    recordTabSelection("location", "/one/location?view=people");

    expect(readPreviousTabHref("ria")).toBe("/ria/profile");
    expect(readPreviousTabHref("location")).toBe("/one/location");
  });

  it("returns null for a tab set with no history", () => {
    expect(readPreviousTabHref("finance")).toBeNull();
  });
});
