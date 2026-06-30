const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Stack-safe Uint8Array -> base64 encoder.
 * Avoids spreading large arrays into String.fromCharCode.
 */
export function bytesToBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  if (!bytes.length) return "";

  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }

  return btoa(binary);
}

/**
 * Base64 -> Uint8Array decoder.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (!base64) return new Uint8Array(new ArrayBuffer(0));
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
