import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The map's own tiles (Google Maps JS canvas) or its iframe fallback are each
// GPU-composited, and Safari/WebKit does not reliably clip a composited
// layer to an ancestor two DOM levels up — the square top corners of the map
// bled past LocalMapPreview's rounded card frame on every surface that
// reuses it (Location, Connect access cards). Rounding LiveMap's own element
// via the className it already forwards is what actually clips it.
describe("LocalMapPreview corner-radius contract", () => {
  it("rounds LiveMap's own element instead of relying on an ancestor clip", () => {
    const source = readFileSync(
      join(process.cwd(), "app/one/location/page.tsx"),
      "utf8",
    );

    const liveMapCallSite = source.match(
      /<LiveMap\b[\s\S]*?\/>/,
    )?.[0];

    expect(liveMapCallSite).toBeDefined();
    expect(liveMapCallSite).toContain(
      'className="rounded-t-[var(--app-card-radius-standard)]"',
    );
  });
});
