import { describe, expect, it } from "vitest";

import {
  normalizeContactPhone,
  resolveContactPhoneRegion,
} from "@/lib/contacts/phone-normalization";

/**
 * Which region a bare `9876543210` is read in, and why the answer cannot be
 * "whatever the device says".
 *
 * A wrong region here does not throw and does not drop the number. It produces
 * a different, entirely plausible E.164 — `+19876543210` instead of
 * `+919876543210` — which hashes to a different digest, misses every match,
 * and tells the person nobody they know is here. The first test below proves
 * that failure mode rather than asserting it.
 *
 * Only Android reports a region derived from the number plan
 * (`simCountryIso`, then `networkCountryIso`). iOS reports `Locale.current`
 * and has nothing better to give — `CTCarrier` has returned dummy values since
 * iOS 16 — and the web picker reports the browser locale. So provenance, not
 * platform, is what ranks the signal.
 */

const BARE_INDIAN_NUMBER = "9876543210";
const INDIAN_ACCOUNT = "+919000000001";

describe("resolveContactPhoneRegion", () => {
  it("silently produces a different number when the region is wrong", () => {
    // The reason any of this matters. Both parse, both are "possible", and
    // nothing downstream can tell they disagree.
    const asIndian = normalizeContactPhone(BARE_INDIAN_NUMBER, "IN");
    const asAmerican = normalizeContactPhone(BARE_INDIAN_NUMBER, "US");

    expect(asIndian?.e164).toBe("+919876543210");
    expect(asAmerican?.e164).toBe("+19876543210");
    expect(asIndian?.e164).not.toBe(asAmerican?.e164);
  });

  it("takes the SIM region first when the device really has a number plan", () => {
    // Android. `simCountryIso` genuinely describes the line the phone is on.
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "IN",
        deviceRegionFromNumberPlan: true,
        accountPhoneNumber: "+15550000001",
        localeTag: "en-US",
      }),
    ).toBe("IN");
  });

  it("prefers the account's own number over a locale-derived device region", () => {
    // iOS with the phone set to English (US), on an Indian account. This is
    // the case that matched nothing.
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "US",
        accountPhoneNumber: INDIAN_ACCOUNT,
        localeTag: "en-US",
      }),
    ).toBe("IN");
  });

  it("treats a missing provenance flag as a locale, not as a number plan", () => {
    // The safe default. A caller that forgets the flag must not silently get
    // the old device-wins behaviour back.
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "US",
        accountPhoneNumber: INDIAN_ACCOUNT,
      }),
    ).toBe("IN");
  });

  it("still uses a locale-derived device region when there is no account number", () => {
    // Email signup, no verified phone. Nothing better exists, and the device's
    // own region setting beats the WebView's language.
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "US",
        accountPhoneNumber: null,
        localeTag: "en-IN",
      }),
    ).toBe("US");
  });

  it("falls back to the locale when nothing else is known", () => {
    expect(resolveContactPhoneRegion({ localeTag: "en-IN" })).toBe("IN");
  });

  it("changes nothing when the signals already agree", () => {
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "IN",
        deviceRegionFromNumberPlan: true,
        accountPhoneNumber: INDIAN_ACCOUNT,
        localeTag: "en-IN",
      }),
    ).toBe("IN");
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "IN",
        accountPhoneNumber: INDIAN_ACCOUNT,
        localeTag: "en-IN",
      }),
    ).toBe("IN");
  });

  it("ignores an unusable device region rather than trusting it", () => {
    expect(
      resolveContactPhoneRegion({
        deviceRegion: "ZZ",
        deviceRegionFromNumberPlan: true,
        accountPhoneNumber: INDIAN_ACCOUNT,
      }),
    ).toBe("IN");
  });
});
