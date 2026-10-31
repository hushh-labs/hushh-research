export interface CardPoint { x: number; y: number }
export type CardCorners = [CardPoint, CardPoint, CardPoint, CardPoint];
export interface CardImageBox { x0: number; y0: number; x1: number; y1: number }
export const FULL_CARD: CardCorners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
export function isFullCard(corners: CardCorners): boolean {
  return corners.every((point, index) => point.x === FULL_CARD[index]!.x && point.y === FULL_CARD[index]!.y);
}

/** Match the centered object-cover preview and its 8% inset camera guide. */
export function cardCameraCaptureBox(width: number, height: number, viewWidth: number, viewHeight: number) {
  const scale = Math.max(viewWidth / width, viewHeight / height);
  const visibleWidth = viewWidth / scale, visibleHeight = viewHeight / scale;
  return { x: (width - visibleWidth) / 2 + visibleWidth * .08, y: (height - visibleHeight) / 2 + visibleHeight * .08, width: visibleWidth * .84, height: visibleHeight * .84 };
}

/** Read dimensions before decoding: compressed byte limits alone are insufficient. */
export async function validateCardImage(file: Blob, budget = { maxBytes: 15 * 1024 * 1024, maxDimension: 10000, maxPixels: 24_000_000 }): Promise<void> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > budget.maxBytes) throw new Error("Choose a JPG, PNG or WebP photo smaller than 15 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let width = 0, height = 0;
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes.length >= 24) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++]!;
      if (marker === 216 || marker === 217) continue;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (kind === "VP8L" && bytes[20] === 47) {
      width = 1 + bytes[21]! + ((bytes[22]! & 63) << 8);
      height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 15) << 10);
    } else if (kind === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
    }
  }
  if (!width || !height || width > budget.maxDimension || height > budget.maxDimension || width * height > budget.maxPixels) throw new Error("Choose a smaller, supported photo (up to 24 megapixels).");
}

export function validCardCorners(points: CardCorners): boolean {
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
  const crosses = points.map((a, i) => { const b = points[(i + 1) % 4]!, c = points[(i + 2) % 4]!; return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); });
  const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % 4]!; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
  return crosses.every(c => c > 0.0001) && area > 0.04;
}

/** Projective mapping, ordered top-left → top-right → bottom-right → bottom-left. */
export function cardProjection(points: CardCorners, u: number, v: number): CardPoint {
  const [a, b, c, d] = points;
  const dx = a.x - b.x + c.x - d.x, dy = a.y - b.y + c.y - d.y;
  const bx = b.x - c.x, by = b.y - c.y, cx = d.x - c.x, cy = d.y - c.y;
  const determinant = bx * cy - cx * by;
  const g = Math.abs(determinant) > 1e-9 ? (dx * cy - cx * dy) / determinant : 0;
  const h = Math.abs(determinant) > 1e-9 ? (bx * dy - dx * by) / determinant : 0;
  const denominator = g * u + h * v + 1;
  return { x: ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / denominator,
    y: ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / denominator };
}
