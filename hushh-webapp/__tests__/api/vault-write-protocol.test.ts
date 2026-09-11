import { describe, expect, it } from "vitest";

import { forwardVaultBackendError } from "@/app/api/vault/_utils/backend-error";
import { VAULT_WRITE_PROTOCOL_VERSION } from "@/lib/vault/write-protocol-version";

describe("vault write protocol compatibility", () => {
  it("keeps the vault protocol independent from the app release version", () => {
    expect(VAULT_WRITE_PROTOCOL_VERSION).toBe("2.0.0");
  });

  it("preserves a structured upgrade error for the vault service", async () => {
    const response = await forwardVaultBackendError(
      new Response(
        JSON.stringify({
          detail: {
            error: "Client upgrade required",
            code: "CLIENT_UPGRADE_REQUIRED",
            minimum_version: "2.0.0",
          },
        }),
        { status: 426 },
      ),
    );

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({
      detail: {
        error: "Client upgrade required",
        code: "CLIENT_UPGRADE_REQUIRED",
        minimum_version: "2.0.0",
      },
    });
  });
});
