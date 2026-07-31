// lib/vault/encrypt.ts

/**
 * Client-Side Data Encryption
 * 
 * Encrypts data with vault key before sending to server.
 * Uses AES-256-GCM (same as consent-protocol backend).
 */
import { bytesToBase64 } from "@/lib/vault/base64";

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  encoding: 'base64';
  algorithm: 'aes-256-gcm';
}

export async function encryptData(
  plaintext: string,
  vaultKeyHex: string
): Promise<EncryptedPayload> {
  const keyBytes = new Uint8Array(
    vaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  const ciphertext = new Uint8Array(encrypted.slice(0, -16));
  const tag = new Uint8Array(encrypted.slice(-16));

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    encoding: "base64",
    algorithm: "aes-256-gcm"
  };
}

// Helper to safely decode Base64 strings (handles URL-safe and padding)
function safeBase64Decode(str: string): Uint8Array {
  // 1. Convert Base64URL to Base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  
  // 2. Add padding if missing
  while (base64.length % 4) {
    base64 += '=';
  }

  // 3. Decode
  try {
    const binaryString = atob(base64);
    return Uint8Array.from(binaryString, c => c.charCodeAt(0));
  } catch (_e) {
    console.error("Failed to decode Base64 string");
    throw new Error("Invalid Base64 string format");
  }
}

export async function decryptData(
  payload: EncryptedPayload,
  vaultKeyHex: string
): Promise<string> {
  const keyBytes = new Uint8Array(
    vaultKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
  );
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Use safe decoder
  const ciphertext = safeBase64Decode(payload.ciphertext);
  const tag = safeBase64Decode(payload.tag);
  const iv = safeBase64Decode(payload.iv);

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    combined as any
  );

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}
