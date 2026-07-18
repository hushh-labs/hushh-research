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

function vaultSetupPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/vault/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

  it("rejects vault setup payloads without a passphrase wrapper", async () => {
    const response = await setupVault(
      vaultSetupPost({
        userId: "user_1",
        vaultKeyHash: "hash",
        primaryMethod: "passkey",
        recoveryEncryptedVaultKey: "encrypted",
        recoverySalt: "salt",
        recoveryIv: "iv",
        wrappers: [
          {
            method: "passkey",
            encryptedVaultKey: "encrypted",
            salt: "salt",
            iv: "iv",
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Passphrase wrapper is required",
    });
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