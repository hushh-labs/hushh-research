/**
 * purposeValidator.ts — unit tests and route-boundary wiring proof.
 *
 * Section 1: Direct unit tests of isPurposeValid / APPROVED_PURPOSES.
 *   Verifies every invalid purpose class is rejected and every approved
 *   purpose is accepted, with no crash on malformed inputs.
 *
 * Section 2: Route-boundary integration proof.
 *   Imports the shipped POST handler from app/api/consent/pending/approve
 *   and asserts that the handler rejects invalid purposes with 400 before
 *   the backend is ever reached — proving the validator is wired into the
 *   live request path, not floating as a standalone helper.
 */

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  APPROVED_PURPOSES,
  isPurposeValid,
} from "@/lib/consent/purposeValidator";

// ── Route-level mocks (hoisted, in place before the route module loads) ───────
vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
}));

vi.mock("@/app/api/_utils/hot-get-json-cache", () => ({
  createHotGetJsonCache: () => ({
    read: vi.fn(() => null),
    getInflight: vi.fn(() => null),
    setInflight: vi.fn(),
    write: vi.fn(),
    clearInflight: vi.fn(),
  }),
}));

vi.mock("@/app/api/_utils/request-id", () => ({
  resolveRequestId: () => "test-rid",
  createUpstreamHeaders: (_id: string, h: Record<string, string>) => h,
  withRequestIdJson: (_id: string, body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      status: (init?.status as number) ?? 200,
      headers: { "content-type": "application/json" },
    }),
}));

import { POST } from "@/app/api/consent/pending/approve/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/consent/pending/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer vault-owner-token",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const VALID_BASE = {
  userId: "user-123",
  requestId: "req-456",
};

// ── Section 1: isPurposeValid — unit tests ────────────────────────────────────

describe("isPurposeValid — direct unit tests", () => {

  describe("approved purposes → true", () => {
    it.each([...APPROVED_PURPOSES])("accepts '%s'", (p) => {
      expect(isPurposeValid(p)).toBe(true);
    });
  });

  describe("invalid purpose strings → false (default-deny)", () => {
    it.each([
      ["null",             null],
      ["undefined",        undefined],
      ["empty string",     ""],
      ["whitespace",       "   "],
      ["unknown string",   "tracking"],
      ["wrong case",       "ANALYTICS"],
      ["trailing space",   "analytics "],
      ["leading space",    " essential"],
      ["numeric string",   "1"],
      ["partial match",    "analytic"],
    ])("%s → false", (_label, value) => {
      expect(isPurposeValid(value)).toBe(false);
    });
  });

  describe("non-string types → false", () => {
    it.each([
      ["number 1",         1],
      ["boolean true",     true],
      ["array",            ["analytics"]],
      ["object",           { purpose: "analytics" }],
    ])("%s → false", (_label, value) => {
      expect(isPurposeValid(value)).toBe(false);
    });
  });

  it("custom allowlist is respected", () => {
    const custom = ["read", "write"] as const;
    expect(isPurposeValid("read",      custom)).toBe(true);
    expect(isPurposeValid("analytics", custom)).toBe(false);
  });

  it("empty allowlist always returns false", () => {
    expect(isPurposeValid("analytics", [])).toBe(false);
  });

  it("return type is always a strict boolean", () => {
    expect(typeof isPurposeValid("analytics")).toBe("boolean");
    expect(typeof isPurposeValid(null)).toBe("boolean");
  });
});

// ── Section 2: Route-boundary proof ──────────────────────────────────────────
// The POST handler must call isPurposeValid before reaching fetch().
// These tests call the shipped handler directly and assert the 400 fires
// *without* any backend call — proving the validator is on the live path.

describe("POST /api/consent/pending/approve — purpose guard (shipped handler)", () => {

  describe("invalid purposes are rejected with 400 — backend never reached", () => {
    it.each([
      ["purpose absent",       { ...VALID_BASE }],
      ["purpose: null",        { ...VALID_BASE, purpose: null }],
      ["purpose: empty",       { ...VALID_BASE, purpose: "" }],
      ["purpose: whitespace",  { ...VALID_BASE, purpose: "   " }],
      ["purpose: unlisted",    { ...VALID_BASE, purpose: "tracking" }],
      ["purpose: wrong case",  { ...VALID_BASE, purpose: "ANALYTICS" }],
      ["purpose: number",      { ...VALID_BASE, purpose: 1 }],
      ["purpose: partial",     { ...VALID_BASE, purpose: "analytic" }],
    ])(
      "%s → 400",
      async (_label, body) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const res = await POST(buildRequest(body));

        expect(res.status).toBe(400);
        const json = await res.json() as { error?: string; allowedPurposes?: string[] };
        expect(json.error).toMatch(/purpose/i);
        // Backend must never be reached for an invalid purpose.
        expect(fetchSpy).not.toHaveBeenCalled();

        fetchSpy.mockRestore();
      }
    );
  });

  describe("approved purposes clear the guard and reach the backend", () => {
    it.each([...APPROVED_PURPOSES])(
      "purpose '%s' clears the guard",
      async (purpose) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ consentToken: "ct_ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );

        const res = await POST(
          buildRequest({ ...VALID_BASE, purpose })
        );

        // Guard cleared — fetch was called exactly once.
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(res.status).toBe(200);

        fetchSpy.mockRestore();
      }
    );
  });

  it("response body lists all allowed purposes when rejecting an invalid one", async () => {
    const res = await POST(
      buildRequest({ ...VALID_BASE, purpose: "unknown" })
    );

    expect(res.status).toBe(400);
    const json = await res.json() as { allowedPurposes?: string[] };
    expect(Array.isArray(json.allowedPurposes)).toBe(true);
    expect(json.allowedPurposes).toEqual(expect.arrayContaining([...APPROVED_PURPOSES]));
  });
});
