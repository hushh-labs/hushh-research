import { describe, expect, it } from "vitest";

import { resolveSmsContactsBackFlow } from "@/components/one-location/redesign/location-redesign-hub";

/**
 * Emergency contacts has two openers, Settings and SOS, and one back arrow.
 *
 * It was hardcoded to Settings on the reasoning that contacts were "only ever
 * opened from Settings". The SOS entry point was added later and the assumption
 * was never revisited, so editing contacts mid-emergency dropped the person out
 * of the SOS flow entirely. These cases exist so a third opener cannot repeat
 * that quietly.
 */
describe("resolveSmsContactsBackFlow", () => {
  it("returns to SOS when SOS opened it", () => {
    expect(resolveSmsContactsBackFlow("sos")).toBe("sos");
  });

  it("returns to Settings for every other opener", () => {
    expect(resolveSmsContactsBackFlow("settings")).toBe("settings");
    expect(resolveSmsContactsBackFlow("nearby")).toBe("settings");
  });

  it("falls back to Settings when no source is recorded", () => {
    // A direct link or a refresh carries no source. Settings is the safe
    // default because every other entry point lives there.
    expect(resolveSmsContactsBackFlow(null)).toBe("settings");
    expect(resolveSmsContactsBackFlow(undefined)).toBe("settings");
    expect(resolveSmsContactsBackFlow("")).toBe("settings");
  });

  it("does not treat a near-miss source as SOS", () => {
    // The value is compared exactly, so a stale or spoofed param cannot land
    // someone in a flow they never opened.
    expect(resolveSmsContactsBackFlow("SOS")).toBe("settings");
    expect(resolveSmsContactsBackFlow("sos-panel")).toBe("settings");
    expect(resolveSmsContactsBackFlow(" sos")).toBe("settings");
  });
});
