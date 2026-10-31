/** Preview-only keys never grant access to the vault or chat history. */
export type NotificationDevice = { userId: string; keyId: string; publicKey: string };
export type ChatPreview = { sender: string; text: string; group?: string; avatar?: string };

export function previewBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function previewBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), c => c.charCodeAt(0));
}

export async function sealNotificationPreview(device: NotificationDevice, context: string, preview: ChatPreview): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const peer = await crypto.subtle.importKey("raw", previewBytes(device.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256);
  try {
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
      info: new TextEncoder().encode(`hussh-chat-preview-v1:${device.keyId}`) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(preview));
    if (plaintext.byteLength > 1800) throw new Error("Notification preview is too large.");
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: new TextEncoder().encode(`${device.keyId}:${context}`) }, key, plaintext);
    return JSON.stringify([device.keyId, previewBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      previewBase64(iv), previewBase64(new Uint8Array(sealed))]);
  } finally { new Uint8Array(secret).fill(0); }
}
