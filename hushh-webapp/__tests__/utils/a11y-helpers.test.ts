import { describe, expect, it } from "vitest";
import { getSemanticLoaderProps } from "@/lib/utils/a11y-helpers";

describe("getSemanticLoaderProps - A11y Contract", () => {
  it("returns polite status roles for standard loading states", () => {
    const props = getSemanticLoaderProps("Fetching market data...");
    expect(props.role).toBe("status");
    expect(props["aria-live"]).toBe("polite");
    expect(props["aria-busy"]).toBe(true);
    expect(props["aria-label"]).toBe("Fetching market data...");
  });

  it("escalates to assertive alert roles for critical loading barriers", () => {
    const props = getSemanticLoaderProps("Decrypting vault, please wait...", true);
    expect(props.role).toBe("alert");
    expect(props["aria-live"]).toBe("assertive");
    expect(props["aria-busy"]).toBe(true);
    expect(props["aria-label"]).toBe("Decrypting vault, please wait...");
  });

  it("provides a safe default loading fallback", () => {
    const props = getSemanticLoaderProps();
    expect(props["aria-label"]).toBe("Loading content...");
  });
});