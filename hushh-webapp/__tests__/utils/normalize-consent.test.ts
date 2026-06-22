import {
  normalizeConsentResponse,
  type NormalizedConsentState,
} from "@/src/lib/consent/normalizeConsent";

// Shorthand for the closed fallback state asserted in integrity-guard tests.
const DENY = { isGranted: false, permissions: [] as string[] };

describe("normalizeConsentResponse", () => {
  it("treats active and granted flags as granted", () => {
    expect(normalizeConsentResponse({ active: true }).isGranted).toBe(true);
    expect(normalizeConsentResponse({ granted: true }).isGranted).toBe(true);
  });

  it("normalizes approved and active statuses as granted", () => {
    expect(normalizeConsentResponse({ status: "approved" }).isGranted).toBe(true);
    expect(normalizeConsentResponse({ status: "active" }).isGranted).toBe(true);
  });

  it("keeps denied, pending, and malformed responses ungranted", () => {
    expect(normalizeConsentResponse({ status: "denied" }).isGranted).toBe(false);
    expect(normalizeConsentResponse({ status: "pending" }).isGranted).toBe(false);
    expect(normalizeConsentResponse(null).isGranted).toBe(false);
  });

  it("deduplicates valid permission and scope strings", () => {
    expect(
      normalizeConsentResponse({
        permissions: ["profile:read", "profile:read", ""],
        scopes: ["vault:read"],
      }).permissions
    ).toEqual(["profile:read", "vault:read"]);
  });

  // â”€â”€ Schema version guard proof â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // cast helper avoids type errors when testing intentionally wrong versions

  describe("schema version guard â€” default-deny on unsupported versions", () => {
    const DENY = { isGranted: false, permissions: [] as string[] };
    const call = (v: unknown) => normalizeConsentResponse(v as never);

    // â”€â”€ Rejection cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("rejects version: 2 (unsupported number)", () => {
      expect(call({ version: 2, active: true })).toStrictEqual(DENY);
    });

    it('rejects version: "2.0" (unsupported string)', () => {
      expect(call({ version: "2.0", granted: true })).toStrictEqual(DENY);
    });

    it("rejects version: null (malformed â€” key present but null)", () => {
      expect(call({ version: null, active: true })).toStrictEqual(DENY);
    });

    it('rejects version: "" (malformed â€” empty string)', () => {
      expect(call({ version: "", active: true })).toStrictEqual(DENY);
    });

    it("rejects version: {} (malformed â€” wrong type)", () => {
      expect(call({ version: {}, active: true })).toStrictEqual(DENY);
    });

    it("rejects version: 0 (falsy number, not a supported version)", () => {
      expect(call({ version: 0, active: true })).toStrictEqual(DENY);
    });

    it("rejects schemaVersion: 99 (unsupported via alias field)", () => {
      expect(call({ schemaVersion: 99, granted: true })).toStrictEqual(DENY);
    });

    it("rejects schemaVersion: null (malformed via alias field)", () => {
      expect(call({ schemaVersion: null, active: true })).toStrictEqual(DENY);
    });

    // â”€â”€ Pass-through cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    it("allows version: 1 (supported) â€” isGranted reflects active flag", () => {
      expect(call({ version: 1, active: true }).isGranted).toBe(true);
      expect(call({ version: 1, active: false }).isGranted).toBe(false);
    });

    it('allows version: "1" (supported string) â€” isGranted reflects granted flag', () => {
      expect(call({ version: "1", granted: true }).isGranted).toBe(true);
    });

    it("allows schemaVersion: 1 (supported via alias) â€” passes through", () => {
      expect(call({ schemaVersion: 1, status: "approved" }).isGranted).toBe(true);
    });

    it("allows payload with no version field (backward-compat contract preserved)", () => {
      expect(call({ active: true }).isGranted).toBe(true);
      expect(call({ status: "approved" }).isGranted).toBe(true);
      expect(call(null).isGranted).toBe(false);
    });
  });
  // â”€â”€ End schema version guard proof â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â”€â”€ Integrity guard proof â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Each case below represents a class of tampered or corrupted payload.
  // The guard must intercept ALL of them before the mapping logic runs and
  // return the closed DENY_STATE â€” fetch/backend never entered.

  describe("integrity guard â€” default-deny on tampered or corrupted payloads", () => {
    const call = (v: unknown) => normalizeConsentResponse(v as never);

    it("rejects string-coerced active flag (truthy injection)", () => {
      expect(call({ active: "true" })).toStrictEqual(DENY);
    });

    it("rejects numeric-coerced granted flag (1 is not a boolean)", () => {
      expect(call({ granted: 1 })).toStrictEqual(DENY);
    });

    it("rejects object status (non-string type in status field)", () => {
      expect(call({ status: {} })).toStrictEqual(DENY);
    });

    it("rejects array-as-status (truncation / wrong type)", () => {
      expect(call({ status: ["approved"] })).toStrictEqual(DENY);
    });

    it("rejects stringified permissions blob (not an array)", () => {
      expect(call({ permissions: "profile:read,vault:read" })).toStrictEqual(DENY);
    });

    it("rejects object-wrapped scopes (not an array)", () => {
      expect(call({ scopes: { 0: "vault:read" } })).toStrictEqual(DENY);
    });

    it("rejects permissions arrays containing non-string values", () => {
      expect(call({ permissions: ["profile:read", 42, null] })).toStrictEqual(DENY);
    });

    it("rejects scopes arrays containing non-string values", () => {
      expect(call({ scopes: ["vault:read", false, {}] })).toStrictEqual(DENY);
    });

    it("rejects array top-level payload (not a plain object)", () => {
      expect(call([{ active: true }])).toStrictEqual(DENY);
    });

    it("rejects prototype-pollution payload (__proto__ own key)", () => {
      // JSON.parse is the safe way to construct an object with __proto__ as an
      // own enumerable key without actually mutating the prototype chain.
      const poisoned = JSON.parse('{"__proto__":{"isGranted":true},"active":true}');
      expect(call(poisoned)).toStrictEqual(DENY);
    });

    it("rejects constructor-poisoning payload (constructor as own key)", () => {
      const poisoned = JSON.parse('{"constructor":{"prototype":{}},"granted":true}');
      expect(call(poisoned)).toStrictEqual(DENY);
    });

    it("passes a well-formed payload through the guard unchanged", () => {
      const result = call({
        active: true,
        granted: true,
        status: "approved",
        permissions: ["profile:read"],
        scopes: ["vault:read"],
      });
      expect(result.isGranted).toBe(true);
      expect(result.permissions).toContain("profile:read");
      expect(result.permissions).toContain("vault:read");
    });

    it("null and undefined still return safe default â€” existing contract preserved", () => {
      expect(call(null)).toStrictEqual(DENY);
      expect(call(undefined)).toStrictEqual(DENY);
    });
  });
  // â”€â”€ End integrity guard proof â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
});

// â”€â”€ Malformed payload â€” strict deny/lockdown posture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The consent state engine must default to the safest possible state
// (isGranted: false, permissions: []) when given any input that is absent,
// null, void, structurally empty, or type-corrupted.  A stale or tampered
// storage payload must never silently elevate access.

describe("normalizeConsentResponse â€” malformed payload defaults to strict deny", () => {
  /** Canonical closed state â€” isGranted false, no permissions. */
  const DENY: NormalizedConsentState = { isGranted: false, permissions: [] };

  // â”€â”€ Absent / void inputs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("returns deny state for undefined â€” void payload yields no access", () => {
    expect(normalizeConsentResponse(undefined)).toEqual(DENY);
  });

  it("returns deny state for an empty object â€” no grant-triggering fields present", () => {
    expect(normalizeConsentResponse({})).toEqual(DENY);
  });

  it("returns deny state when active and granted are undefined and status is null", () => {
    expect(
      normalizeConsentResponse({ active: undefined, granted: undefined, status: null })
    ).toEqual(DENY);
  });

  // â”€â”€ Explicit falsy flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("returns deny state when all boolean flags are explicitly false", () => {
    expect(
      normalizeConsentResponse({ active: false, granted: false, status: "" })
    ).toEqual(DENY);
  });

  it("returns deny state when active is falsy numeric zero", () => {
    // 0 is falsy; the function must not treat it as a boolean true.
    expect(
      normalizeConsentResponse({ active: 0 as never }).isGranted
    ).toBe(false);
  });

  // â”€â”€ Non-grant and partial status strings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("returns deny state for rejection-class status strings", () => {
    const rejectStatuses = [
      "denied", "rejected", "revoked", "expired",
      "cancelled", "blocked", "forbidden",
    ];
    for (const status of rejectStatuses) {
      expect(
        normalizeConsentResponse({ status }).isGranted,
        `status "${status}" should deny access`,
      ).toBe(false);
    }
  });

  it("returns deny state for partial status strings that do not exactly match a grant value", () => {
    // "approve" vs "approved", "grant" vs "granted", "activ" vs "active" â€”
    // prefix matches must not grant access.
    const partialStatuses = ["approve", "grant", "activ", "APPROVED", " approved "];
    for (const status of partialStatuses) {
      // Note: the engine lowercases and trims, so "APPROVED" â†’ "approved" DOES
      // grant (correct). Truly partial strings like "approve" must not.
      const willGrant = ["approved", "active", "granted"].includes(
        status.trim().toLowerCase()
      );
      expect(
        normalizeConsentResponse({ status }).isGranted,
        `status "${status}" unexpected result`,
      ).toBe(willGrant);
    }
  });

  it("returns deny state for empty, whitespace-only, and numeric-looking status strings", () => {
    for (const status of ["", "   ", "1", "0", "true", "yes"]) {
      expect(
        normalizeConsentResponse({ status }).isGranted,
        `status "${status}" should not grant`,
      ).toBe(false);
    }
  });

  // â”€â”€ Corrupted permission / scope fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("produces empty permissions when the permissions field is a string (type corruption)", () => {
    // A stringified permissions blob must not surface as a permission entry.
    const result = normalizeConsentResponse({
      permissions: "profile:read,vault:read" as never,
    });
    expect(result.permissions).toEqual([]);
    expect(result.isGranted).toBe(false);
  });

  it("produces empty permissions when the array contains only non-string entries", () => {
    const result = normalizeConsentResponse({
      permissions: [null, undefined, 42, {}, true, []] as never,
    });
    expect(result.permissions).toEqual([]);
    expect(result.isGranted).toBe(false);
  });

  it("strips all empty and whitespace-only permission strings", () => {
    const result = normalizeConsentResponse({
      permissions: ["", "   ", "\t", "\n"],
    });
    expect(result.permissions).toEqual([]);
    expect(result.isGranted).toBe(false);
  });

  it("produces empty permissions when scopes field is not an array", () => {
    const result = normalizeConsentResponse({
      scopes: { "vault:read": true } as never,
    });
    expect(result.permissions).toEqual([]);
  });

  // â”€â”€ Non-object runtime inputs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("defaults to deny for primitive non-object inputs (runtime corruption guard)", () => {
    // These simulate corrupted storage payloads being passed at runtime.
    // cast via `never` to bypass TypeScript while keeping eslint clean.
    const corruptedInputs: never[] = [
      "corrupted-string" as never,
      42 as never,
      false as never,
      [] as never,
    ];

    for (const input of corruptedInputs) {
      const result = normalizeConsentResponse(input);
      expect(result.isGranted, `input ${JSON.stringify(input)} should deny`).toBe(false);
      expect(result.permissions, `input ${JSON.stringify(input)} should have no permissions`).toEqual([]);
    }
  });

  // â”€â”€ Return shape contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("always returns the exact NormalizedConsentState shape â€” never throws or returns undefined", () => {
    // Every input class must produce the closed shape, not throw or return null.
    const inputs = [null, undefined, {}, { active: false }, { status: "denied" }];
    for (const input of inputs) {
      const result = normalizeConsentResponse(input as never);
      expect(typeof result.isGranted).toBe("boolean");
      expect(Array.isArray(result.permissions)).toBe(true);
    }
  });
});
// â”€â”€ End malformed payload coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
