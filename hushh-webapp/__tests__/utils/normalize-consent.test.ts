import { normalizeConsentResponse } from "@/src/lib/consent/normalizeConsent";

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

  // ── Schema version guard proof ────────────────────────────────────────────
  // cast helper avoids type errors when testing intentionally wrong versions

  describe("schema version guard — default-deny on unsupported versions", () => {
    const DENY = { isGranted: false, permissions: [] as string[] };
    const call = (v: unknown) => normalizeConsentResponse(v as never);

    // ── Rejection cases ─────────────────────────────────────────────────────

    it("rejects version: 2 (unsupported number)", () => {
      expect(call({ version: 2, active: true })).toStrictEqual(DENY);
    });

    it('rejects version: "2.0" (unsupported string)', () => {
      expect(call({ version: "2.0", granted: true })).toStrictEqual(DENY);
    });

    it("rejects version: null (malformed — key present but null)", () => {
      expect(call({ version: null, active: true })).toStrictEqual(DENY);
    });

    it('rejects version: "" (malformed — empty string)', () => {
      expect(call({ version: "", active: true })).toStrictEqual(DENY);
    });

    it("rejects version: {} (malformed — wrong type)", () => {
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

    // ── Pass-through cases ──────────────────────────────────────────────────

    it("allows version: 1 (supported) — isGranted reflects active flag", () => {
      expect(call({ version: 1, active: true }).isGranted).toBe(true);
      expect(call({ version: 1, active: false }).isGranted).toBe(false);
    });

    it('allows version: "1" (supported string) — isGranted reflects granted flag', () => {
      expect(call({ version: "1", granted: true }).isGranted).toBe(true);
    });

    it("allows schemaVersion: 1 (supported via alias) — passes through", () => {
      expect(call({ schemaVersion: 1, status: "approved" }).isGranted).toBe(true);
    });

    it("allows payload with no version field (backward-compat contract preserved)", () => {
      expect(call({ active: true }).isGranted).toBe(true);
      expect(call({ status: "approved" }).isGranted).toBe(true);
      expect(call(null).isGranted).toBe(false);
    });
  });
  // ── End schema version guard proof ───────────────────────────────────────
});
