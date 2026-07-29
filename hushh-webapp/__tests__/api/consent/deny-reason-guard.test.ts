/**
 * Denial-reason guard proof for POST /api/consent/pending/deny
 *
 * Calls the shipped route handler (POST) directly — not through ApiService —
 * so every assertion targets the actual request boundary.
 *
 * Rejection cases confirm:
 *   1. The handler returns 400 immediately.
 *   2. fetch() is NEVER called — the backend is never reached.
 *
 * Pass-through cases confirm each approved reason clears the guard and
 * proceeds to the backend fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
}));

import { POST } from "@/app/api/consent/pending/deny/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/consent/pending/deny", {
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
  JSON.stringify({ status: "denied" }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/consent/pending/deny — denial-reason guard (inline default-deny)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rejection cases ───────────────────────────────────────────────────────

  describe("rejects invalid reason with 400 — backend fetch() never called", () => {
    it.each([
      ["reason key absent",           { ...BASE_BODY }],
      ["reason: null",                { ...BASE_BODY, reason: null }],
      ["reason: empty string",        { ...BASE_BODY, reason: "" }],
      ["reason: whitespace only",     { ...BASE_BODY, reason: "   " }],
      ["reason: free-form text",      { ...BASE_BODY, reason: "I just don't want to" }],
      ["reason: unlisted category",   { ...BASE_BODY, reason: "unknown-reason" }],
      ["reason: wrong case",          { ...BASE_BODY, reason: "User-Declined" }],
      ["reason: numeric type",        { ...BASE_BODY, reason: 0 }],
      ["reason: boolean type",        { ...BASE_BODY, reason: false }],
      ["reason: array type",          { ...BASE_BODY, reason: ["user-declined"] }],
    ])(
      "%s → 400 and fetch not called",
      async (_label, body) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const response = await POST(buildRequest(body));

        expect(response.status).toBe(400);
        const json = await response.json() as { error?: string };
        expect(json.error).toMatch(/reason/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    );
  });

  // ── Pass-through cases ────────────────────────────────────────────────────

  describe("allows every approved denial reason through to backend", () => {
    it.each([
      "user-declined",
      "scope-too-broad",
      "policy-violation",
      "expired-request",
      "duplicate-request",
    ])(
      "reason '%s' clears guard and reaches backend",
      async (reason) => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(MOCK_BACKEND_OK.clone());

        const response = await POST(
          buildRequest({ ...BASE_BODY, reason })
        );

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
      }
    );
  });

  // ── Error message shape ───────────────────────────────────────────────────

  it("error body names the approved-categories requirement", async () => {
    const response = await POST(
      buildRequest({ ...BASE_BODY, reason: "nope" })
    );
    const json = await response.json() as { error?: string };
    expect(json.error).toContain("approved denial categories");
  });
});
