/**
 * Purpose guard proof for POST /api/consent/pending/approve
 *
 * Calls the shipped route handler (POST) directly — not through ApiService —
 * so every assertion targets the actual request boundary, not a client stub.
 *
 * Rejection cases confirm that:
 *   1. The handler returns 400 immediately.
 *   2. fetch() is NEVER called — the backend is never reached.
 *
 * Pass-through cases confirm that each approved purpose clears the guard and
 * proceeds to the backend fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Module-level mock (hoisted before all imports) ────────────────────────────
vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
}));

// Import the live handler AFTER mock is registered.
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

const BASE_BODY = { userId: "user-123", requestId: "req-456" };

const MOCK_BACKEND_OK = new Response(
  JSON.stringify({ consentToken: "ct_ok" }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

// ── Test suites ───────────────────────────────────────────────────────────────

describe("POST /api/consent/pending/approve — purpose guard (inline default-deny)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rejection cases ───────────────────────────────────────────────────────

  describe("rejects invalid purpose with 400 — backend fetch() never called", () => {
    it.each([
      ["purpose key absent",          { ...BASE_BODY }],
      ["purpose: null",               { ...BASE_BODY, purpose: null }],
      ["purpose: empty string",       { ...BASE_BODY, purpose: "" }],
      ["purpose: whitespace only",    { ...BASE_BODY, purpose: "   " }],
      ["purpose: unlisted string",    { ...BASE_BODY, purpose: "tracking" }],
      ["purpose: wrong case",         { ...BASE_BODY, purpose: "ANALYTICS" }],
      ["purpose: numeric type",       { ...BASE_BODY, purpose: 1 }],
      ["purpose: boolean type",       { ...BASE_BODY, purpose: true }],
      ["purpose: array type",         { ...BASE_BODY, purpose: ["analytics"] }],
      ["purpose: partial match",      { ...BASE_BODY, purpose: "analytic" }],
    ])(
      "%s → 400 and fetch not called",
      async (_label, body) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const response = await POST(buildRequest(body));

        expect(response.status).toBe(400);
        const json = await response.json() as { error?: string };
        expect(json.error).toMatch(/purpose/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    );
  });

  // ── Pass-through cases ────────────────────────────────────────────────────

  describe("allows every approved purpose through to backend", () => {
    it.each([
      "essential",
      "analytics",
      "marketing",
      "personalization",
      "research",
    ])(
      "purpose '%s' clears guard and reaches backend",
      async (purpose) => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(MOCK_BACKEND_OK.clone());

        const response = await POST(
          buildRequest({ ...BASE_BODY, purpose })
        );

        // Guard cleared — backend was called exactly once.
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
      }
    );
  });

  // ── Error message shape ───────────────────────────────────────────────────

  it("error body names the approved-tiers requirement", async () => {
    const response = await POST(
      buildRequest({ ...BASE_BODY, purpose: "profiling" })
    );
    const json = await response.json() as { error?: string };
    expect(json.error).toContain("approved operational tiers");
  });
});
