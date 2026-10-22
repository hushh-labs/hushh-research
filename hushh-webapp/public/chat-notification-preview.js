/* Preview-only WebCrypto keys; decrypted text lives only during OS rendering. */
self.currentChatNotificationKey = async function () {
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("hussh-chat-preview-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get("active");
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    return record?.keyId || null;
  } catch (_) { return null; }
  finally { db?.close(); }
};
self.openChatNotificationPreview = async function (data, field = "chat_preview") {
  if (!data[field]) return null;
  let db;
  try {
    if (String(data[field]).length > 2600) return null;
    const envelope = JSON.parse(data[field]);
    if (!Array.isArray(envelope) || envelope.length !== 4) return null;
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("hussh-chat-preview-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get("active");
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    if (!record || record.keyId !== envelope[0]) return null;
    const decode = text => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), c => c.charCodeAt(0));
    const peer = await crypto.subtle.importKey("raw", decode(envelope[1]), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, record.privateKey, 256);
    try {
      const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
        info: new TextEncoder().encode(`hussh-chat-preview-v1:${record.keyId}`) }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope[2]),
        additionalData: new TextEncoder().encode(`${record.keyId}:${data.preview_context}`) }, key, decode(envelope[3]));
      if (plain.byteLength > 1800) return null;
      const preview = JSON.parse(new TextDecoder().decode(plain));
      if (typeof preview.text !== "string") return null;
      return preview;
    } finally { new Uint8Array(secret).fill(0); }
  } catch (_) { return null; }
  finally { db?.close(); }
};
