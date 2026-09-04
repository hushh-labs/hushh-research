import { beforeEach, describe, expect, it } from "vitest";

import {
  ACCENT_NO_FOUC_SCRIPT,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  normalizeAccent,
  readAccent,
  resolvedAccentHex,
  writeAccent,
} from "@/lib/theme/accent";

describe("app accent preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
  });

  it("defaults to iOS Blue with no data-accent attribute", () => {
    expect(DEFAULT_ACCENT).toBe("blue");
    expect(readAccent()).toBe("blue");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  it("normalizes unknown values to the default", () => {
    expect(normalizeAccent("crimson")).toBe("blue");
    expect(normalizeAccent(null)).toBe("blue");
    expect(normalizeAccent("gold")).toBe("gold");
  });

  it("persists gold and projects data-accent on the html element", () => {
    expect(writeAccent("gold")).toBe("gold");
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("gold");
    expect(document.documentElement.getAttribute("data-accent")).toBe("gold");
    expect(readAccent()).toBe("gold");
  });

  it("returning to blue removes the attribute (default needs none)", () => {
    writeAccent("gold");
    writeAccent("blue");
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(readAccent()).toBe("blue");
  });

  it("no-FOUC script matches the storage key and only sets gold", () => {
    expect(ACCENT_NO_FOUC_SCRIPT).toContain(ACCENT_STORAGE_KEY);
    expect(ACCENT_NO_FOUC_SCRIPT).toContain('"gold"');
    // Blue is the attribute-free default; the script must never set blue.
    expect(ACCENT_NO_FOUC_SCRIPT).not.toContain('setAttribute("data-accent","blue")');
  });
});

/**
 * The accent as a literal, for a consumer that lives outside the CSS cascade.
 *
 * `@capacitor/google-maps` is the reason this exists: it hands circle and
 * polyline options straight to `new google.maps.Circle` on web, which falls
 * back to its OWN defaults on an unparseable colour, and to
 * `UIColor(hex:) ?? .blue` on iOS. A `var(--app-accent)` string reaching
 * either one produces a colour nobody chose, and both look deliberate.
 */
describe("the accent, resolved to a literal", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.style.removeProperty("--app-accent");
  });

  it("never returns something a native bridge cannot parse", () => {
    // JSDOM resolves no stylesheet, so this is the no-token path — the one a
    // real browser hits before first paint.
    expect(resolvedAccentHex()).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("prefers the computed token over its own fallback", () => {
    document.documentElement.style.setProperty("--app-accent", "#123456");
    expect(resolvedAccentHex()).toBe("#123456");
  });

  it("refuses a token that is not a literal colour", () => {
    // A token defined in terms of another var(), or empty during first paint,
    // is exactly what must NOT reach the bridge — passing it through is how
    // the check-in radius ring shipped in Google's default styling.
    document.documentElement.style.setProperty(
      "--app-accent",
      "var(--something-else)",
    );
    expect(resolvedAccentHex()).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resolvedAccentHex()).not.toContain("var(");
  });

  it("follows the accent PREFERENCE when there is no computed token", () => {
    // The whole reason this reads the token instead of hardcoding a hex: gold
    // is a different colour, and a literal would freeze the map overlay to
    // one palette while every other surface followed the preference.
    const blue = resolvedAccentHex();
    writeAccent("gold");
    const gold = resolvedAccentHex();
    expect(gold).not.toBe(blue);
    expect(gold).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
