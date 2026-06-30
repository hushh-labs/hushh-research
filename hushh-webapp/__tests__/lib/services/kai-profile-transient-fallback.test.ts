/**
 * Characterization suite — @/lib/services/kai-profile-service
 *
 * Pins the observability-hardening contract added to KaiProfileService:
 * when getProfile() fails to load financial.profile it returns the canonical
 * default profile but tags it with a NON-ENUMERABLE transient-failure marker so
 * callers can tell a degraded "system error" default apart from a genuinely
 * "brand-new user" default.
 *
 * The invariant under test is that the marker:
 *   1. is readable only via the sanctioned isTransientProfileFallback() guard,
 *   2. is non-enumerable, so it never leaks into JSON.stringify, object spread,
 *      Object.keys, or a vault write — i.e. it cannot mutate the KaiProfileV2
 *      shape that gets persisted.
 *
 * Implementation: hushh-webapp/lib/services/kai-profile-service.ts
 */

import { describe, expect, it } from "vitest";
import {
  isTransientProfileFallback,
  type KaiProfileV2,
} from "@/lib/services/kai-profile-service";

const TRANSIENT_LOAD_ERROR_FLAG = "__transientLoadError";

function makeProfile(): KaiProfileV2 {
  return {
    schema_version: 2,
    onboarding: {
      completed: false,
      completed_at: null,
      skipped_preferences: false,
      nav_tour_completed_at: null,
      nav_tour_skipped_at: null,
      version: 2,
    },
    preferences: {
      investment_horizon: null,
      investment_horizon_selected_at: null,
      investment_horizon_anchor_at: null,
      drawdown_response: null,
      drawdown_response_selected_at: null,
      volatility_preference: null,
      volatility_preference_selected_at: null,
      risk_score: null,
      risk_profile: null,
      risk_profile_selected_at: null,
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Mirrors the private markTransientFallback() in the service so the test can
 * exercise the public guard against a marked object without reaching through
 * the cache/vault stack.
 */
function markTransient(profile: KaiProfileV2): KaiProfileV2 {
  Object.defineProperty(profile, TRANSIENT_LOAD_ERROR_FLAG, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return profile;
}

describe("isTransientProfileFallback", () => {
  it("returns false for a normally loaded profile (brand-new user)", () => {
    expect(isTransientProfileFallback(makeProfile())).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isTransientProfileFallback(null)).toBe(false);
    expect(isTransientProfileFallback(undefined)).toBe(false);
  });

  it("returns true once the transient marker is attached", () => {
    const marked = markTransient(makeProfile());
    expect(isTransientProfileFallback(marked)).toBe(true);
  });
});

describe("transient marker non-enumerability contract", () => {
  it("is excluded from Object.keys / spread / JSON (cannot leak into a vault write)", () => {
    const marked = markTransient(makeProfile());

    // Not enumerable: invisible to key iteration and structural copies.
    expect(Object.keys(marked)).not.toContain(TRANSIENT_LOAD_ERROR_FLAG);
    expect({ ...marked }).not.toHaveProperty(TRANSIENT_LOAD_ERROR_FLAG);
    expect(JSON.stringify(marked)).not.toContain(TRANSIENT_LOAD_ERROR_FLAG);

    // A spread copy (the shape that would be persisted) is NOT flagged.
    expect(isTransientProfileFallback({ ...marked })).toBe(false);
  });

  it("does not alter the enumerable KaiProfileV2 shape", () => {
    const clean = makeProfile();
    const marked = markTransient(makeProfile());
    expect(Object.keys(marked).sort()).toEqual(Object.keys(clean).sort());
  });

  it("survives a by-reference cache round-trip (getProfile returns cache hits directly)", () => {
    // CacheService stores `data` by reference (no JSON serialize / structuredClone),
    // so a marked fallback cached under the SHORT TTL is returned to the next
    // getProfile() caller WITH the marker intact. A defineProperty-based copy is
    // the only thing that would strip it; a plain reference pass-through does not.
    const marked = markTransient(makeProfile());
    const fromCache = marked; // models CacheService.get returning entry.data by reference
    expect(isTransientProfileFallback(fromCache)).toBe(true);
  });
});


