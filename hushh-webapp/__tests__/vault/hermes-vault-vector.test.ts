import vector from "../fixtures/hermes-vault-vector.json";

import { VaultService } from "@/lib/services/vault-service";
import { unlockVaultWithPassphrase } from "@/lib/vault/passphrase-key";

describe("Hermes vault crypto vector", () => {
  it("unwraps and hashes identically to the native bridge", async () => {
    const vaultKey = await unlockVaultWithPassphrase(
      vector.passphrase,
      vector.encrypted_vault_key_b64,
      vector.salt_b64,
      vector.iv_b64,
    );

    expect(vaultKey).toBe(vector.vault_key_hex);
    expect(await VaultService.hashVaultKey(vaultKey)).toBe(vector.vault_key_hash);
  });
});
