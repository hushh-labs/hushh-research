import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression (UAT, 2026-08-08): claiming an RIA profile left the profile screen
 * hanging forever.
 *
 * The claim screen reads `onboarding/status` BEFORE the claim (answer:
 * exists=false); the proxy caches that for 30s. `POST claim/complete` was not on
 * the invalidation list, so the post-claim force-refresh was served the stale
 * exists=false with a 200 and persisted client-side for 30 minutes. The profile
 * screen then believed the adviser had no profile.
 *
 * Source-level assertions: these proxies are Next route handlers whose caches
 * are module-local, so the cheapest honest guard is that the invalidation and
 * the force-bypass stay in the code.
 */

const WEBAPP_ROOT = join(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("RIA proxy invalidates the onboarding status cache on claim mutations", () => {
  const source = readSource("app/api/ria/[...path]/route.ts");

  it("busts the status cache for every claim step, not only claim/email", () => {
    expect(source).toContain('path.startsWith("claim/")');
    expect(source).toContain("hotGetCache.delete(`onboarding/status:${authHeader}`)");
  });

  it("still busts it for a licence refresh", () => {
    expect(source).toContain('path === "profile/refresh-license"');
  });
});

describe("IAM proxy honours a forced persona read", () => {
  const source = readSource("app/api/iam/[...path]/route.ts");

  it("skips the cache hit when force=1 is requested", () => {
    // The key omitted the query string, so ?force=1 — sent specifically to
    // bypass caching — was answered from this cache.
    expect(source).toContain('searchParams.get("force") === "1"');
    expect(source).toContain("const hotCacheKey = forceRefresh ? null : personaCacheKey;");
  });

  it("still writes the fresh answer and can still fall back to stale", () => {
    expect(source).toContain("writeHotGetCache(personaCacheKey, result)");
    expect(source).toContain("readHotGetCache(personaCacheKey, { allowStale: true })");
  });
});
