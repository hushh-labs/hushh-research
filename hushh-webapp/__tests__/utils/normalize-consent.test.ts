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

  // ── Integrity guard proof ──────────────────────────────────────────────────
  // Each case below represents a class of tampered or corrupted payload.
  // The guard must intercept ALL of them before the mapping logic runs and
  // return the closed DENY_STATE — fetch/backend never entered.

  describe("integrity guard — default-deny on tampered or corrupted payloads", () => {
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

    it("null and undefined still return safe default — existing contract preserved", () => {
      expect(call(null)).toStrictEqual(DENY);
      expect(call(undefined)).toStrictEqual(DENY);
    });
  });
  // ── End integrity guard proof ──────────────────────────────────────────────
});

// ── Malformed payload — strict deny/lockdown posture ──────────────────────────
//
// The consent state engine must default to the safest possible state
// (isGranted: false, permissions: []) when given any input that is absent,
// null, void, structurally empty, or type-corrupted.  A stale or tampered
// storage payload must never silently elevate access.

describe("normalizeConsentResponse — malformed payload defaults to strict deny", () => {
  /** Canonical closed state — isGranted false, no permissions. */
  const DENY: NormalizedConsentState = { isGranted: false, permissions: [] };

  // ── Absent / void inputs ─────────────────────────────────────────────────

  it("returns deny state for undefined — void payload yields no access", () => {
    expect(normalizeConsentResponse(undefined)).toEqual(DENY);
  });

  it("returns deny state for an empty object — no grant-triggering fields present", () => {
    expect(normalizeConsentResponse({})).toEqual(DENY);
  });

  it("returns deny state when active and granted are undefined and status is null", () => {
    expect(
      normalizeConsentResponse({ active: undefined, granted: undefined, status: null })
    ).toEqual(DENY);
  });

  // ── Explicit falsy flags ─────────────────────────────────────────────────

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

  // ── Non-grant and partial status strings ─────────────────────────────────

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
    // "approve" vs "approved", "grant" vs "granted", "activ" vs "active" —
    // prefix matches must not grant access.
    const partialStatuses = ["approve", "grant", "activ", "APPROVED", " approved "];
    for (const status of partialStatuses) {
      // Note: the engine lowercases and trims, so "APPROVED" → "approved" DOES
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

  // ── Corrupted permission / scope fields ──────────────────────────────────

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

  // ── Non-object runtime inputs ─────────────────────────────────────────────

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

  // ── Return shape contract ─────────────────────────────────────────────────

  it("always returns the exact NormalizedConsentState shape — never throws or returns undefined", () => {
    // Every input class must produce the closed shape, not throw or return null.
    const inputs = [null, undefined, {}, { active: false }, { status: "denied" }];
    for (const input of inputs) {
      const result = normalizeConsentResponse(input as never);
      expect(typeof result.isGranted).toBe("boolean");
      expect(Array.isArray(result.permissions)).toBe(true);
    }
  });
});
// ── End malformed payload coverage ───────────────────────────────────────────

// ── Empty-array boundary conditions ──────────────────────────────────────────
//
// The consent-matching layer accepts empty arrays `[]` as structurally valid
// (the integrity guard checks `Array.isArray`, and `Array.isArray([]) === true`).
// Empty arrays must not silently slip through evaluation loops to produce
// unexpected permission entries or spurious grant signals.
//
// Contracts under test:
//   A. An empty permissions or scopes array alone yields DENY — no entries
//      means no permission strings surface and no grant signal fires.
//   B. An empty array alongside an explicit grant flag (active/granted/status)
//      returns isGranted: true but an empty permission list — the grant signal
//      is honoured; the empty array is not silently promoted to a grant.
//   C. One empty, one non-empty: only the non-empty side contributes entries.
//   D. The integrity guard passes empty arrays cleanly (no false positive deny).

describe("normalizeConsentResponse — empty array boundary conditions", () => {
  const DENY: NormalizedConsentState = { isGranted: false, permissions: [] };

  // ── A: empty arrays alone → DENY ─────────────────────────────────────────

  it("returns DENY when permissions is an empty array and no grant signal is present", () => {
    // The filter loop iterates zero items — nothing can slip through.
    expect(normalizeConsentResponse({ permissions: [] })).toEqual(DENY);
  });

  it("returns DENY when scopes is an empty array and no grant signal is present", () => {
    expect(normalizeConsentResponse({ scopes: [] })).toEqual(DENY);
  });

  it("returns DENY when both permissions and scopes are empty arrays", () => {
    // Merging [] and [] produces []; the spread never appends any entry.
    expect(normalizeConsentResponse({ permissions: [], scopes: [] })).toEqual(DENY);
  });

  it("returns DENY when both empty arrays accompany a non-granting status string", () => {
    expect(
      normalizeConsentResponse({ permissions: [], scopes: [], status: "pending" })
    ).toEqual(DENY);
  });

  // ── B: empty arrays + explicit grant flag ─────────────────────────────────

  it("returns isGranted: true with empty permissions when active: true accompanies an empty permissions array", () => {
    // The grant comes from the boolean flag, not from permissions — the empty
    // array must not promote or suppress the grant.
    const result = normalizeConsentResponse({ active: true, permissions: [] });
    expect(result.isGranted).toBe(true);
    expect(result.permissions).toEqual([]);
  });

  it("returns isGranted: true with empty permissions when granted: true accompanies an empty scopes array", () => {
    const result = normalizeConsentResponse({ granted: true, scopes: [] });
    expect(result.isGranted).toBe(true);
    expect(result.permissions).toEqual([]);
  });

  it("returns isGranted: true with empty permissions when status is 'approved' and both arrays are empty", () => {
    const result = normalizeConsentResponse({
      status: "approved",
      permissions: [],
      scopes: [],
    });
    expect(result.isGranted).toBe(true);
    expect(result.permissions).toEqual([]);
  });

  it("returns isGranted: true with empty permissions when status is 'active' and both arrays are empty", () => {
    const result = normalizeConsentResponse({
      status: "active",
      permissions: [],
      scopes: [],
    });
    expect(result.isGranted).toBe(true);
    expect(result.permissions).toEqual([]);
  });

  // ── C: one empty, one non-empty ───────────────────────────────────────────

  it("surfaces only the non-empty permissions when scopes is an empty array", () => {
    const result = normalizeConsentResponse({
      permissions: ["profile:read", "vault:read"],
      scopes: [],
    });
    expect(result.permissions).toEqual(["profile:read", "vault:read"]);
  });

  it("surfaces only the non-empty scopes when permissions is an empty array", () => {
    const result = normalizeConsentResponse({
      permissions: [],
      scopes: ["vault:read"],
    });
    expect(result.permissions).toEqual(["vault:read"]);
  });

  it("merges non-empty permissions with empty scopes and deduplicates correctly", () => {
    const result = normalizeConsentResponse({
      permissions: ["profile:read", "profile:read"],
      scopes: [],
    });
    expect(result.permissions).toEqual(["profile:read"]);
  });

  // ── D: integrity guard passes empty arrays (no false-positive deny) ───────

  it("does not deny a payload with an empty permissions array (guard accepts valid arrays)", () => {
    // The guard only checks Array.isArray — an empty array is structurally
    // valid and must pass through, not trigger the DENY_STATE path.
    // Proof: add a grant signal alongside the empty array and confirm it is
    // honoured (isGranted: true).  If the guard had fired it would return
    // DENY_STATE and isGranted would be false regardless of the flag.
    expect(
      normalizeConsentResponse({ permissions: [], active: true }).isGranted
    ).toBe(true);
  });

  it("does not deny a payload with an empty scopes array (guard accepts valid arrays)", () => {
    const withGrant = normalizeConsentResponse({ scopes: [], granted: true });
    expect(withGrant.isGranted).toBe(true);
  });

  it("never throws when permissions and scopes are both empty arrays", () => {
    // Zero-iteration safety: the filter loop must handle [] without error.
    expect(() =>
      normalizeConsentResponse({ permissions: [], scopes: [] })
    ).not.toThrow();
  });
});
// ── End empty-array boundary conditions ──────────────────────────────────────
