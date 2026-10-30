import { afterEach, describe, expect, it } from "vitest";

import { resolveWebPasskeyDeviceLabel } from "@/lib/services/vault-bootstrap-service";

// Chrome's Client Hints spec requires browsers to ship a randomized "GREASE"
// brand entry in navigator.userAgentData.brands so sites can't hardcode a
// match against it — the punctuation between "Not"/"A"/"Brand" varies by
// session. A label built from an unfiltered brand read "Not-A?Brand passkey
// on Windows" in production because the old filter only recognized one
// punctuation combination.
const GREASE_BRAND_VARIANTS = [
  "Not;A Brand",
  "Not.A/Brand",
  "Not-A?Brand",
  "Not A;Brand",
  "Not_A_Brand",
  "Not/A)Brand",
];

function stubUserAgentData(
  brands: Array<{ brand: string; version: string }>,
  platform = "Windows",
) {
  Object.defineProperty(window.navigator, "userAgentData", {
    value: { brands, platform },
    configurable: true,
  });
}

describe("resolveWebPasskeyDeviceLabel", () => {
  afterEach(() => {
    // @ts-expect-error test-only cleanup of a stubbed property
    delete window.navigator.userAgentData;
  });

  it.each(GREASE_BRAND_VARIANTS)(
    "filters out the GREASE placeholder brand %j and falls back to a real brand",
    (greaseBrand) => {
      stubUserAgentData([
        { brand: greaseBrand, version: "24" },
        { brand: "Chromium", version: "128" },
        { brand: "Google Chrome", version: "128" },
      ]);

      const label = resolveWebPasskeyDeviceLabel();

      expect(label).toBe("Google Chrome passkey on Windows");
      expect(label.toLowerCase()).not.toContain("not");
    },
  );

  it("falls back to the user-agent string when every brand is filtered out", () => {
    stubUserAgentData([{ brand: "Not-A?Brand", version: "24" }]);

    const label = resolveWebPasskeyDeviceLabel();

    // No usable brand survives the filter, so this must never surface the
    // placeholder text — it should read from navigator.userAgent instead.
    expect(label.toLowerCase()).not.toContain("not-a");
    expect(label.toLowerCase()).not.toContain("not;a");
  });
});
