/** Bounded RGBA raster operations and metadata-free PNG encoding. Pure pixel work
 * runs in the owned worker, including browsers without OffscreenCanvas. */
export interface CardRaster { width: number; height: number; data: Uint8ClampedArray }
/** Flatten worker-owned pixels onto white. Transparent RGB/alpha cannot preserve
 * an invisible copy of printed details in the newly encoded approved raster. */
export function flattenCardTransparency(image: CardRaster): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3]! / 255;
    if (alpha < 1) for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = Math.round(image.data[offset + channel]! * alpha + 255 * (1 - alpha));
    image.data[offset + 3] = 255;
  }
}
const encoder = new TextEncoder();
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, data.length); result.set(encoder.encode(name), 4); result.set(data, 8);
  view.setUint32(result.length - 4, crc(result.subarray(4, result.length - 4))); return result;
}
function storedDeflate(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const count = Math.ceil(bytes.length / 65535), result = new Uint8Array(bytes.length + count * 5 + 6);
  result.set([0x78, 0x01]); let offset = 2, sumA = 1, sumB = 0;
  for (let start = 0; start < bytes.length; start += 65535) {
    const block = bytes.subarray(start, start + 65535), length = block.length;
    result.set([start + length === bytes.length ? 1 : 0, length & 255, length >> 8, (~length) & 255, ((~length) >> 8) & 255], offset); offset += 5;
    result.set(block, offset); offset += length;
    for (const byte of block) { sumA = (sumA + byte) % 65521; sumB = (sumB + sumA) % 65521; }
  }
  new DataView(result.buffer).setUint32(offset, ((sumB << 16) | sumA) >>> 0); return result;
}
export async function encodeCardPng(raster: CardRaster): Promise<Blob> {
  const { width, height, data } = raster;
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const compressed = typeof CompressionStream === "function"
    ? new Uint8Array(await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer())
    : storedDeflate(rows);
  const header = new Uint8Array(13); const view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())], { type: "image/png" });
}
/** Decoder restricted to our fresh RGBA/8-bit/no-filter PNG. This inspection
 * reads the FINAL encoded bytes, not an uncensored source canvas. */
export async function decodeCardPng(blob: Blob): Promise<CardRaster> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width * height > 4_000_000 || bytes[24] !== 8 || bytes[25] !== 6) throw new Error("Invalid raster");
  const size = view.getUint32(33), compressed = bytes.slice(41, 41 + size);
  let rows: Uint8Array;
  if (typeof DecompressionStream === "function") rows = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  else {
    const blocks: Uint8Array[] = []; let offset = 2, total = 0;
    while (offset < compressed.length - 4) { if ((compressed[offset]! & 6) !== 0) throw new Error("Unsupported raster"); const length = compressed[offset + 1]! | (compressed[offset + 2]! << 8); offset += 5; blocks.push(compressed.slice(offset, offset + length)); total += length; offset += length; }
    rows = new Uint8Array(total); let target = 0; for (const block of blocks) { rows.set(block, target); target += block.length; }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  if (rows.length !== height * (width * 4 + 1)) throw new Error("Invalid raster");
  for (let y = 0; y < height; y++) { if (rows[y * (width * 4 + 1)] !== 0) throw new Error("Invalid raster"); data.set(rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4); }
  return { width, height, data };
}

export function rasterCanvas(width: number, height: number) {
  let raster: CardRaster = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const value = { width, height, raster: () => raster, convertToBlob: (_options?: object) => encodeCardPng(raster) };
  const context = {
    fillStyle: "#171b24",
    getImageData: (_x: number, _y: number, _w: number, _h: number) => ({ ...raster, data: raster.data.slice() }),
    createImageData: (w: number, h: number): CardRaster => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: CardRaster, _x: number, _y: number) => { raster = image; },
    drawImage: (source: { raster: () => CardRaster }, _x: number, _y: number, w: number, h: number) => {
      const input = source.raster();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const from = (Math.min(input.height - 1, Math.floor(y * input.height / h)) * input.width + Math.min(input.width - 1, Math.floor(x * input.width / w))) * 4;
        const target = (y * width + x) * 4; raster.data.set(input.data.subarray(from, from + 4), target);
      }
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let row = Math.max(0, Math.floor(y)); row < Math.min(height, Math.ceil(y + h)); row++) for (let col = Math.max(0, Math.floor(x)); col < Math.min(width, Math.ceil(x + w)); col++) raster.data.set([23, 27, 36, 255], (row * width + col) * 4);
    },
  };
  return { value, context };
}
