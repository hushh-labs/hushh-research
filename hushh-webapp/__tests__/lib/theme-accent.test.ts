import { beforeEach, describe, expect, it } from "vitest";

import {
  ACCENT_NO_FOUC_SCRIPT,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  normalizeAccent,
  readAccent,
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
