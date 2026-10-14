// Normalize slow lighting changes locally, without uploading or storing the photo.
export async function normalizeCardLighting(photo: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(photo);
  try {
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image processing unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const gray = new Uint8Array(width * height);
    const stride = width + 1;
    const sums = new Float64Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        gray[i] = Math.round(.299 * pixels.data[i * 4]! + .587 * pixels.data[i * 4 + 1]! + .114 * pixels.data[i * 4 + 2]!);
        row += gray[i]!;
        sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + row;
      }
    }
    const radius = Math.max(16, Math.round(Math.min(width, height) / 12));
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
      for (let x = 0; x < width; x++) {
        const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
        const mean = (sums[bottom * stride + right]! - sums[top * stride + right]! - sums[bottom * stride + left]! + sums[top * stride + left]!) / ((right - left) * (bottom - top));
        const i = y * width + x;
        const value = Math.min(255, Math.round(gray[i]! * 230 / Math.max(1, mean)));
        pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = value;
      }
    }
    context.putImageData(pixels, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image processing unavailable")), "image/png"));
  } finally { bitmap.close(); }
}
