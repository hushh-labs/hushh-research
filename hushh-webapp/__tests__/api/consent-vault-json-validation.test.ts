import { NextRequest } from "next/server";

import { POST as cancelConsent } from "@/app/api/consent/cancel/route";
import { POST as logoutConsent } from "@/app/api/consent/logout/route";
import { POST as revokeConsent } from "@/app/api/consent/revoke/route";
import { POST as issueSessionToken } from "@/app/api/consent/session-token/route";
import { POST as setupVault } from "@/app/api/vault/setup/route";

function malformedPost(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
}

async function expectInvalidJson(response: Response) {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: "Invalid JSON payload",
  });
}

describe("malformed JSON route handling", () => {
  it("rejects malformed vault setup payloads before backend work", async () => {
    await expectInvalidJson(
      await setupVault(malformedPost("/api/vault/setup")),
    );
  });

  it.each([
    ["/api/consent/cancel", cancelConsent],
    ["/api/consent/logout", logoutConsent],
    ["/api/consent/revoke", revokeConsent],
    ["/api/consent/session-token", issueSessionToken],
  ])("rejects malformed consent payloads for %s", async (path, handler) => {
    await expectInvalidJson(await handler(malformedPost(path)));
  });
});

// ── Content-Type enforcement — non-JSON ingestion gate ───────────────────────
//
// The consent ingestion routes use readJsonObject() from @/app/api/_utils/json-body
// as their entryway gate.  readJsonObject() calls request.json() and returns null
// on any failure, triggering invalidJsonPayloadResponse() with status 400.
//
// A request carrying a non-JSON Content-Type with a plain-text, HTML, or
// form-encoded body will always fail the JSON parse step — the body is not valid
// JSON — so it is rejected with 400 before any field extraction or backend
// proxying occurs.  These tests pin that behaviour for three Content-Type
// variants that a misconfigured or spoofed client might send.
//
// Routes under test:
//   POST /api/vault/setup          (vault/setup/route.ts)
//   POST /api/consent/cancel       (consent/cancel/route.ts)
//   POST /api/consent/logout       (consent/logout/route.ts)
//   POST /api/consent/revoke       (consent/revoke/route.ts)
//   POST /api/consent/session-token(consent/session-token/route.ts)

// ── Content-Type: text/plain ──────────────────────────────────────────────────

describe("Content-Type enforcement — non-JSON ingestion gate", () => {
  it.each([
    ["/api/vault/setup",          setupVault],
    ["/api/consent/cancel",       cancelConsent],
    ["/api/consent/logout",       logoutConsent],
    ["/api/consent/revoke",       revokeConsent],
    ["/api/consent/session-token",issueSessionToken],
  ])(
    "rejects text/plain payload at the ingestion gate for %s before field extraction",
    async (path, handler) => {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        // Realistic non-JSON text body a misconfigured client might send
        body: "userId=user_123&requestId=req_abc&scope=pkm.read",
      });
      await expectInvalidJson(await handler(req));
    }
  );

  // ── Content-Type: application/x-www-form-urlencoded ──────────────────────────

  it.each([
    ["/api/vault/setup",          setupVault],
    ["/api/consent/cancel",       cancelConsent],
    ["/api/consent/revoke",       revokeConsent],
    ["/api/consent/session-token",issueSessionToken],
  ])(
    "rejects form-encoded payload at the ingestion gate for %s before field extraction",
    async (path, handler) => {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // Form-encoded body that looks like it carries real field values
        body: "userId=user_123&requestId=req_abc&scope=pkm.read",
      });
      await expectInvalidJson(await handler(req));
    }
  );

  // ── Content-Type: text/html ───────────────────────────────────────────────────

  it.each([
    ["/api/vault/setup",    setupVault],
    ["/api/consent/cancel", cancelConsent],
    ["/api/consent/revoke", revokeConsent],
  ])(
    "rejects text/html payload at the ingestion gate for %s before field extraction",
    async (path, handler) => {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: "<request><userId>user_123</userId><requestId>req_abc</requestId></request>",
      });
      await expectInvalidJson(await handler(req));
    }
  );

  // ── Missing Content-Type header ───────────────────────────────────────────────

  it.each([
    ["/api/vault/setup",          setupVault],
    ["/api/consent/cancel",       cancelConsent],
    ["/api/consent/session-token",issueSessionToken],
  ])(
    "rejects plain-text body with no Content-Type header for %s before backend proxying",
    async (path, handler) => {
      // No content-type header at all — the body is unambiguously not JSON
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        body: "plain text payload sent without a content type declaration",
      });
      await expectInvalidJson(await handler(req));
    }
  );
});
