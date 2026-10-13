"use client";

import { bytesToBase64 } from "@/lib/vault/base64";
import { deriveKeyFromPassphrase } from "@/lib/vault/passphrase-key";

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (!normalized || normalized.length % 2 !== 0) {
    throw new Error("Invalid vault key hex format.");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    const pair = normalized.slice(i, i + 2);
    const value = Number.parseInt(pair, 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid vault key hex value.");
    }
    bytes[i / 2] = value;
  }
  return bytes;
}

export async function rewrapVaultKeyWithPassphrase(params: {
  vaultKeyHex: string;
  wrappingSecret: string;
}): Promise<{
  encryptedVaultKey: string;
  salt: string;
  iv: string;
}> {
  const rawVaultKey = hexToBytes(params.vaultKeyHex);
  const rawVaultKeyBuffer = new ArrayBuffer(rawVaultKey.byteLength);
  new Uint8Array(rawVaultKeyBuffer).set(rawVaultKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const wrappingKey = await deriveKeyFromPassphrase(params.wrappingSecret, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    rawVaultKeyBuffer
  );

  return {
    encryptedVaultKey: bytesToBase64(new Uint8Array(encrypted)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
  };
}
