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
