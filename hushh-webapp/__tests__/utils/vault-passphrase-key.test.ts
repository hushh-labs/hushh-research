import { describe, expect, it } from "vitest";

import {
  createVaultWithPassphrase,
  unlockVaultWithPassphrase,
} from "@/lib/vault/passphrase-key";

describe("unlockVaultWithPassphrase - mismatched salt handling", () => {
  it("fails closed when a passphrase wrapper uses a mismatched salt", async () => {
    const passphrase = "test-passphrase";
    const wrapper = await createVaultWithPassphrase(passphrase);

    await expect(
      unlockVaultWithPassphrase(
        passphrase,
        wrapper.encryptedVaultKey,
        wrapper.salt,
        wrapper.iv
      )
    ).resolves.toBe(wrapper.vaultKeyHex);

    await expect(
      unlockVaultWithPassphrase(
        passphrase,
        wrapper.encryptedVaultKey,
        "AAAAAAAAAAAAAAAAAAAAAA==",
        wrapper.iv
      )
    ).resolves.toBe("");
  });
});
