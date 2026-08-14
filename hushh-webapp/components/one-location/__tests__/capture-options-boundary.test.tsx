/**
 * Latency and freshness contracts for the One Location surface.
 *
 * Every assertion here was written after a real defect, and each one guards a
 * property that a type signature cannot:
 *
 * 1. Capture options must SURVIVE the prop boundary. The nearby check-in
 *    confirmation asks for a genuinely fresh fix with `{ maxAgeMs: 0 }`, but
 *    the function supplying that prop was declared with ZERO parameters.
 *    TypeScript permits the narrower arity — a function may always ignore its
 *    arguments — so it compiled clean, linted clean, passed every test, and
 *    silently discarded the option. The persisted radius anchor could be 20s
 *    stale while a comment three lines above promised it was fresh.
 *
 * 2. A mutating CTA must not hold its spinner across a full state reload. That
 *    round trip is bookkeeping the user is not waiting on, and it was most of
 *    what "every click takes seconds" meant.
 *
 * 3. Sharing must fan out concurrently, but BOUNDED — each grant costs two
 *    pooled database connections server-side.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("One Location capture-options boundary", () => {
  it("the map's capture forwarders declare and pass their options", () => {
    const source = read("components/one-location/location-immersive-map.tsx");

    // Declared with the parameter — a zero-arity declaration is the bug.
    expect(source).toContain(
      "const captureCurrentLocation = useCallback(\n    (options?: {\n      maxAgeMs?: number;\n      fresh?: boolean;\n    }): Promise<PlainLocationPoint> => {",
    );
    expect(source).toContain(
      "async (options?: { maxAgeMs?: number; fresh?: boolean }) => {\n      const point = await captureCurrentLocation(options);",
    );

    // And actually forwarded to the service, not dropped.
    expect(source).toContain(
      "OneLocationService.captureCurrentPosition(options)",
    );
    expect(source).not.toContain(
      "const captureAndRememberCurrentLocation = useCallback(async () => {",
    );
  });

  it("an in-flight capture is not handed to a caller demanding a fresh fix", () => {
    const source = read("components/one-location/location-immersive-map.tsx");

    // Deduplication is right for cached-eligible callers and wrong for a
    // check-in anchor that must describe where the user is standing now.
    expect(source).toContain(
      "options?.maxAgeMs !== 0 &&\n        !options?.fresh",
    );
  });

  it("the check-in confirmation anchors on a current fix, not a stale one", () => {
    const source = read(
      "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
    );
    expect(source).toContain("captureCurrentPosition({ fresh: true })");
  });

  it("the check-in sheet's prop type accepts options at all", () => {
    const source = read(
      "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
    );
    expect(source).toContain(
      "captureCurrentPosition: (options?: {\n    maxAgeMs?: number;\n    fresh?: boolean;\n  }) => Promise<PlainLocationPoint>;",
    );
  });
});

describe("One Location CTA latency contract", () => {
  const page = () => read("app/one/location/page.tsx");

  it("no mutating CTA awaits a full state reload before releasing its spinner", () => {
    // `await refresh()` inside a handler adds a whole round trip to perceived
    // latency after the work is already done and toasted.
    expect(page()).not.toContain("await refresh();");
  });

  it("backgrounded reloads still swallow their own failure", () => {
    // A bare `void refresh()` would surface as an unhandled rejection, and a
    // reload that failed after a successful revoke used to be reported to the
    // user as "Could not revoke access" — blaming the operation that worked.
    const source = page();
    const backgrounded = source.match(/void refresh\(\)/g) ?? [];
    const handled = source.match(/void refresh\(\)\s*\.catch\(/g) ?? [];
    expect(backgrounded.length).toBeGreaterThan(0);
    expect(handled.length).toBe(backgrounded.length);
  });

  it("sharing fans out concurrently rather than one recipient at a time", () => {
    const source = page();
    expect(source).toContain("ONE_LOCATION_SHARE_CONCURRENCY");
    // The sequential shape this replaced.
    expect(source).not.toContain(
      "for (const recipient of shareReadySelectedRecipients) {",
    );
  });

  it("share fan-out stays bounded so it cannot exhaust the connection pool", () => {
    const source = page();
    const match = source.match(/ONE_LOCATION_SHARE_CONCURRENCY = (\d+)/);
    expect(match).toBeTruthy();
    const limit = Number(match?.[1]);
    expect(limit).toBeGreaterThan(1); // otherwise it is still sequential
    expect(limit).toBeLessThanOrEqual(8); // each grant costs 2 DB connections
    expect(source).toContain(
      "Math.min(ONE_LOCATION_SHARE_CONCURRENCY, pending.length)",
    );
  });

  it("both live-publish loops isolate failures per recipient", () => {
    const source = page();
    // One recipient throwing must not starve the others — with stable grant
    // ordering, a shared catch starved everyone after the failure on EVERY tick.
    expect(source).not.toContain("for (const grant of activeOwnerGrants) {");
    expect(source).toContain("activeOwnerGrants.map(async (grant) => {");
  });

  it("the review queue warms the position before Approve is pressed", () => {
    const source = page();
    expect(source).toContain(
      "void OneLocationService.captureCurrentPosition().catch(() => null);",
    );
    // Never outside a granted permission: an ungated capture would spend the
    // single system prompt iOS grants at a moment the user cannot explain.
    expect(source).toContain('if (permission?.state !== "granted") return;');
  });

  it("live publishing never serves a recipient a reused fix", () => {
    const source = page();
    expect(source).toContain(
      "const point = await OneLocationService.captureCurrentPosition({\n          maxAgeMs: 0,\n        });",
    );
  });
});
