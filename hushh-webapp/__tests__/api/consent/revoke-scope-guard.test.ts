/**
 * Scope guard proof for POST /api/consent/revoke
 *
 * Calls the shipped route handler (POST) directly — not through ApiService —
 * so every assertion targets the actual request boundary.
 *
 * Rejection cases confirm:
 *   1. Handler returns 400 immediately.
 *   2. fetch() is NEVER called — backend never reached.
 *
 * Pass-through cases confirm each revocable scope clears the guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://mock-backend",
}));

vi.mock("@/app/api/_utils/json-body", () => ({
  invalidJsonPayloadResponse: () =>
    new Response(JSON.stringify({ error: "invalid payload" }), { status: 400 }),
  readJsonObject: async (req: Request) => {
    try {
      return await req.json();
    } catch {
      return null;
    }
  },
}));

import { POST } from "@/app/api/consent/revoke/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRequest(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost/api/consent/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer vault-owner-token",
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const BASE_BODY = { userId: "user-123" };

const MOCK_BACKEND_OK = new Response(
  JSON.stringify({ status: "revoked" }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/consent/revoke — scope guard (inline default-deny)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rejection cases ───────────────────────────────────────────────────────

  describe("rejects invalid scope with 400 — backend fetch() never called", () => {
    it.each([
      ["scope: unlisted string",   { ...BASE_BODY, scope: "notifications" }],
      ["scope: wildcard",          { ...BASE_BODY, scope: "*" }],
      ["scope: SQL fragment",      { ...BASE_BODY, scope: "read; DROP TABLE" }],
      ["scope: wrong case",        { ...BASE_BODY, scope: "READ" }],
      ["scope: partial match",     { ...BASE_BODY, scope: "reads" }],
      ["scope: empty string",      { ...BASE_BODY, scope: "" }],
      ["scope: numeric type",      { ...BASE_BODY, scope: 1 }],
      ["scope: boolean type",      { ...BASE_BODY, scope: true }],
      ["scope: array type",        { ...BASE_BODY, scope: ["read"] }],
    ])(
      "%s → 400 and fetch not called",
      async (_label, body) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const response = await POST(buildRequest(body));

        expect(response.status).toBe(400);
        const json = await response.json() as { error?: string };
        expect(json.error).toMatch(/scope/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    );
  });

  // ── Pass-through cases ────────────────────────────────────────────────────

  describe("allows every revocable scope through to backend", () => {
    it.each([
      "read",
      "write",
      "export",
      "full",
      "analytics",
      "marketing",
      "personalization",
    ])(
      "scope '%s' clears guard and reaches backend",
      async (scope) => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(MOCK_BACKEND_OK.clone());

        const response = await POST(
          buildRequest({ ...BASE_BODY, scope })
        );

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
      }
    );
  });

  // ── Error message shape ───────────────────────────────────────────────────

  it("error body names the revocable-scopes requirement", async () => {
    const response = await POST(
      buildRequest({ ...BASE_BODY, scope: "admin" })
    );
    const json = await response.json() as { error?: string };
    expect(json.error).toContain("revocable consent scopes");
  });
});
