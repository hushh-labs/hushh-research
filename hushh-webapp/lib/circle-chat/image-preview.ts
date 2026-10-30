import { MAX_CHAT_THUMBNAIL_BYTES, type ChatImageThumbnail } from "./crypto";

/** Built from the already-decoded attachment, without another file read. */
export function createChatImageThumbnail(image: HTMLImageElement): ChatImageThumbnail | undefined {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return undefined;
    const canvas = document.createElement("canvas");
    for (const edge of [96, 64, 32]) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.6);
      if (!url.startsWith("data:image/jpeg;base64,")) return undefined;
      const data = url.slice("data:image/jpeg;base64,".length);
      if (data.length <= Math.ceil(MAX_CHAT_THUMBNAIL_BYTES / 3) * 4) return { type: "image/jpeg", data };
    }
  } catch { /* Preview generation must never prevent sending the original. */ }
  return undefined;
}
