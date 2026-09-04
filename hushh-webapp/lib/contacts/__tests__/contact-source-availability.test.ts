import { describe, expect, it } from "vitest";

import { resolveContactSourceProbeFailure } from "@/lib/contacts/contact-source-availability";

describe("contact source availability after a failed probe", () => {
  it("keeps iOS and Android contact actions available for a tap-time retry", () => {
    expect(
      resolveContactSourceProbeFailure({
        native: true,
        googleConfigured: false,
      }),
    ).toEqual({ available: true, googleFallback: false });
  });

  it("uses Google only as a web fallback", () => {
    expect(
      resolveContactSourceProbeFailure({
        native: false,
        googleConfigured: true,
      }),
    ).toEqual({ available: true, googleFallback: true });
  });

  it("stays unavailable on web when no source can be reached", () => {
    expect(
      resolveContactSourceProbeFailure({
        native: false,
        googleConfigured: false,
      }),
    ).toEqual({ available: false, googleFallback: false });
  });
});
