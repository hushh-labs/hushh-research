import { FULL_CARD, validCardCorners, type CardCorners } from "./card-scan-image";
import { rasterCanvas, type CardRaster } from "./card-scan-raster";

/** Bounded suggestion only. Similar foreground/background falls back to manual
 * corners; a color boundary is never treated as proof of the physical card. */
export function detectCardRegion(image: CardRaster): { corners: CardCorners; detected: boolean } {
  const scale = Math.min(1, 512 / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
  const sample = rasterCanvas(width, height); sample.context.drawImage({ raster: () => image }, 0, 0, width, height);
  const pixels = sample.value.raster().data, background = [0, 0, 0];
  for (const index of [0, width - 1, (height - 1) * width, width * height - 1]) for (let channel = 0; channel < 3; channel++) background[channel] = background[channel]! + pixels[index * 4 + channel]! / 4;
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let largest: number[] = [];
  const foreground = (index: number) => [0, 1, 2].reduce((sum, channel) => sum + (pixels[index * 4 + channel]! - background[channel]!) ** 2, 0) > 70 ** 2;
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || !foreground(start)) continue;
    let head = 0, tail = 1; queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]!, x = index % width;
      for (const next of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, index - width, index + width]) {
        if (next < 0 || next >= visited.length || visited[next]) continue;
        visited[next] = 1; if (foreground(next)) queue[tail++] = next;
      }
    }
    if (tail > largest.length) largest = Array.from(queue.subarray(0, tail));
  }
  if (largest.length < width * height * .15 || largest.length > width * height * .95) return { corners: FULL_CARD, detected: false };
  const extremes = [largest[0]!, largest[0]!, largest[0]!, largest[0]!];
  const metric = (index: number, corner: number) => { const x = index % width, y = Math.floor(index / width); return corner === 0 ? -x - y : corner === 1 ? x - y : corner === 2 ? x + y : -x + y; };
  for (const index of largest) for (let corner = 0; corner < 4; corner++) if (metric(index, corner) > metric(extremes[corner]!, corner)) extremes[corner] = index;
  const corners = extremes.map(index => ({ x: (index % width) / (width - 1), y: Math.floor(index / width) / (height - 1) })) as CardCorners;
  return validCardCorners(corners) ? { corners, detected: true } : { corners: FULL_CARD, detected: false };
}
