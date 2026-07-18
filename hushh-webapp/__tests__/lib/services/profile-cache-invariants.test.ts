import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Characterization: KaiProfileService.getProfile cache + structural invariants.
 *
 * Truth-first scope (verified against hushh-webapp/lib/services/kai-profile-service.ts):
 *  - getProfile is I/O-bound: it reads CacheService.getInstance() and, on miss,
 *    calls getFinancialDomain() which fans out to PersonalKnowledgeModelService /
 *    PkmDomainResourceService (vault + network). It is NOT a pure function.
 *  - createDefaultProfile() and normalizeProfile() are NOT exported, so they cannot
 *    be imported directly. The only public surface is KaiProfileService.getProfile.
 *
 * Therefore this suite drives the PUBLIC method and stubs ONLY the PKM/network
 * loader (the established repo mocking pattern), while exercising the REAL
 * CacheService. We characterize the deterministic catch-path fallback profile
 * (createDefaultProfile) because it is the one back-to-back-stable shape that does
 * not depend on decrypted vault contents. This pins:
 *   1. The strict nested KaiProfileV2 shape (schema_version / onboarding / preferences).
 *   2. The back-to-back cache invariant: second read is a cache hit returning the
 *      same reference, with identical nested onboarding structure and types.
 *
 * This documents current shipped behavior; it does not assert a "should".
 */

// Force the loader to fail so getProfile takes its deterministic fallback branch.
// (getFinancialDomain → getStaleFirst is the first call inside the try block.)
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: vi.fn(async () => {
      throw new Error("forced loader failure (characterization)");
    }),
    invalidateDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    loadDomainData: vi.fn(async () => {
      throw new Error("forced loader failure (characterization)");
    }),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    enqueueDomainWrite: vi.fn(async () => undefined),
  },
}));

import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";

// Suppress the expected console.warn emitted on the fallback path.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.clearAllMocks();
});

function loadParams(userId: string) {
  return { userId, vaultKey: "test-vault-key" };
}

describe("KaiProfileService.getProfile · cache + structural invariants (public contract)", () => {
  it("returns a strictly-shaped KaiProfileV2 with the expected nested onboarding and preferences structure", async () => {
    const userId = "user-shape-1";
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(userId));

    const profile = await KaiProfileService.getProfile(loadParams(userId));

    // Top-level shape.
    expect(profile.schema_version).toBe(2);
    expect(typeof profile.updated_at).toBe("string");
    expect(profile.updated_at.length).toBeGreaterThan(0);

    // Nested onboarding sub-object keeps its full key set and types.
    expect(profile.onboarding).toMatchObject({
      completed: false,
      completed_at: null,
      skipped_preferences: false,
      version: 2,
    });
    expect(Object.keys(profile.onboarding).sort()).toEqual(
      [
        "completed",
        "completed_at",
        "nav_tour_completed_at",
        "nav_tour_skipped_at",
        "skipped_preferences",
        "version",
      ].sort(),
    );

    // Nested preferences sub-object: pristine state is all-null with risk_score null.
    expect(profile.preferences.investment_horizon).toBeNull();
    expect(profile.preferences.drawdown_response).toBeNull();
    expect(profile.preferences.volatility_preference).toBeNull();
    expect(profile.preferences.risk_score).toBeNull();
    expect(profile.preferences.risk_profile).toBeNull();
  });

  it("serves back-to-back reads from cache: the second call returns the same cached reference", async () => {
    const userId = "user-cache-hit";
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(userId));

    const first = await KaiProfileService.getProfile(loadParams(userId));
    const second = await KaiProfileService.getProfile(loadParams(userId));

    // CacheService returns the stored reference on hit (no re-derivation).
    expect(second).toBe(first);
  });

  it("preserves nested onboarding structure and types across back-to-back reads", async () => {
    const userId = "user-nested-stable";
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(userId));

    const first = await KaiProfileService.getProfile(loadParams(userId));
    const second = await KaiProfileService.getProfile(loadParams(userId));

    // Deep structural equality of the nested onboarding + preferences shapes.
    expect(second.onboarding).toStrictEqual(first.onboarding);
    expect(second.preferences).toStrictEqual(first.preferences);
    expect(second.schema_version).toBe(first.schema_version);

    // Type integrity of nested onboarding fields is retained.
    expect(typeof second.onboarding.completed).toBe("boolean");
    expect(typeof second.onboarding.version).toBe("number");
    expect(second.onboarding.completed_at).toBeNull();
  });

  it("does not invoke the loader again on a cache hit (back-to-back stability is cache-served)", async () => {
    const { PkmDomainResourceService } = await import("@/lib/pkm/pkm-domain-resource");
    const getStaleFirst = PkmDomainResourceService.getStaleFirst as ReturnType<typeof vi.fn>;

    const userId = "user-no-reload";
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(userId));
    getStaleFirst.mockClear();

    await KaiProfileService.getProfile(loadParams(userId));
    const callsAfterFirst = getStaleFirst.mock.calls.length;
    await KaiProfileService.getProfile(loadParams(userId));
    const callsAfterSecond = getStaleFirst.mock.calls.length;

    // First read hit the loader (miss → fallback); second read was cache-served.
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("isolates cache entries per user: distinct userIds get independent profile objects", async () => {
    const a = "user-iso-a";
    const b = "user-iso-b";
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(a));
    CacheService.getInstance().invalidate(CACHE_KEYS.KAI_PROFILE(b));

    const profileA = await KaiProfileService.getProfile(loadParams(a));
    const profileB = await KaiProfileService.getProfile(loadParams(b));

    // Different cache keys → different stored references, identical structure.
    expect(profileA).not.toBe(profileB);
    expect(profileA.onboarding).toStrictEqual(profileB.onboarding);
    expect(profileA.preferences).toStrictEqual(profileB.preferences);
  });
});
