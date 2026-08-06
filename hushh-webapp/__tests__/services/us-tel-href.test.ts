import { describe, expect, it } from "vitest";

import { usTelHref } from "@/lib/services/us-tel-href";

describe("usTelHref", () => {
  it("adds +1 to the bare ten-digit numbers US directories serve", () => {
    expect(usTelHref("612-3712811")).toBe("tel:+16123712811");
    expect(usTelHref("(425) 803-8300")).toBe("tel:+14258038300");
  });

  it("adds only the + when the country code is already there", () => {
    expect(usTelHref("1-612-371-2811")).toBe("tel:+16123712811");
    expect(usTelHref("+1 612 371 2811")).toBe("tel:+16123712811");
  });

  it("passes a foreign country code through instead of forcing +1", () => {
    expect(usTelHref("+44 20 7946 0958")).toBe("tel:+442079460958");
  });

  it("leaves a shape it does not recognize alone rather than guessing", () => {
    expect(usTelHref("371-2811")).toBe("tel:3712811");
  });
});
