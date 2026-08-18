import {
  createVaultWithPassphrase,
  unlockVaultWithPassphrase,
  unlockVaultWithRecoveryKey,
} from "@/lib/vault/passphrase-key";

// CS-4 fix (security assessment, 2026-08-17): PBKDF2 rounds went from
// 100,000 to 600,000. Existing vaults were encrypted at 100,000 rounds, so
// unlock must keep deriving old rows at 100,000 while new vaults use
// 600,000 — see decodeVersionedSalt in lib/vault/passphrase-key.ts.
describe("passphrase-key PBKDF2 round versioning (CS-4)", () => {
  const passphrase = "correct horse battery staple";

  it("stretches new vaults at the current (600,000) round count and unlocks them correctly", async () => {
    const vault = await createVaultWithPassphrase(passphrase);

    // The persisted salt string must actually carry the new round count,
    // not just derive at it silently — this is what makes it safe for the
    // backend to store as an opaque field forever.
    expect(vault.salt).toContain("600000");
    expect(vault.recoverySalt).toContain("600000");

    const unlocked = await unlockVaultWithPassphrase(
      passphrase,
      vault.encryptedVaultKey,
      vault.salt,
      vault.iv,
    );
    expect(unlocked).toBe(vault.vaultKeyHex);

    const unlockedFromRecovery = await unlockVaultWithRecoveryKey(
      vault.recoveryKey,
      vault.recoveryEncryptedVaultKey,
      vault.recoverySalt,
      vault.recoveryIv,
    );
    expect(unlockedFromRecovery).toBe(vault.vaultKeyHex);
  });

  it("still unlocks a legacy vault whose salt has no version prefix, at the original 100,000 rounds", async () => {
    // Simulates a row persisted before this fix: derive+encrypt exactly the
    // way the old, unversioned code path did (plain base64 salt, no prefix).
    const legacySalt = crypto.getRandomValues(new Uint8Array(16));
    const legacyIv = crypto.getRandomValues(new Uint8Array(12));
    const vaultKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const vaultKeyRaw = await crypto.subtle.exportKey("raw", vaultKey);
    const vaultKeyHex = Array.from(new Uint8Array(vaultKeyRaw))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const legacyKeyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    const legacyDerivedKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: legacySalt, iterations: 100_000, hash: "SHA-256" },
      legacyKeyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: legacyIv },
      legacyDerivedKey,
      vaultKeyRaw,
    );

    const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
    const legacySaltB64 = toB64(legacySalt);
    expect(legacySaltB64.startsWith("hushh-kdf-v2:")).toBe(false);

    const unlocked = await unlockVaultWithPassphrase(
      passphrase,
      toB64(new Uint8Array(encryptedBuffer)),
      legacySaltB64,
      toB64(legacyIv),
    );
    expect(unlocked).toBe(vaultKeyHex);
  });

  it("returns an empty string (not a throw) for a wrong passphrase against a new-format vault", async () => {
    const vault = await createVaultWithPassphrase(passphrase);
    const unlocked = await unlockVaultWithPassphrase(
      "definitely the wrong passphrase",
      vault.encryptedVaultKey,
      vault.salt,
      vault.iv,
    );
    expect(unlocked).toBe("");
  });
});
