import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";

function decodeBinary(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Encrypted binary field is empty.");
  if (text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text) && !/[+/=_-]/.test(text)) {
    return Buffer.from(text, "hex");
  }
  let normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  return Buffer.from(normalized, "base64");
}

export function decryptAesGcm({ ciphertext, iv, tag }, key) {
  const encrypted = decodeBinary(ciphertext);
  const authTag = tag ? decodeBinary(tag) : encrypted.subarray(encrypted.length - 16);
  const body = tag ? encrypted : encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, decodeBinary(iv));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function deriveVaultKeyForExplicitOutput(vaultState, passphrase) {
  const wrappers = Array.isArray(vaultState?.wrappers) ? vaultState.wrappers : [];
  const wrapper = wrappers.find(
    (candidate) => String(candidate?.method || "").toLowerCase() === "passphrase"
  );
  if (!wrapper) throw new Error("Reviewer vault has no passphrase wrapper.");
  const derived = pbkdf2Sync(
    Buffer.from(passphrase, "utf8"),
    decodeBinary(wrapper.salt),
    100_000,
    32,
    "sha256"
  );
  let vaultKey;
  try {
    vaultKey = decryptAesGcm(
      {
        ciphertext: wrapper.encryptedVaultKey || wrapper.encrypted_vault_key,
        iv: wrapper.iv,
      },
      derived
    );
  } finally {
    derived.fill(0);
  }
  if (vaultKey.length !== 32) throw new Error("Reviewer vault key is not 256 bits.");
  const expectedHash = String(vaultState.vaultKeyHash || vaultState.vault_key_hash || "");
  const actualHash = createHash("sha256")
    .update(vaultKey.toString("hex"), "utf8")
    .digest("hex");
  if (expectedHash && actualHash !== expectedHash) {
    vaultKey.fill(0);
    throw new Error("Reviewer vault key integrity check failed.");
  }
  return vaultKey;
}
