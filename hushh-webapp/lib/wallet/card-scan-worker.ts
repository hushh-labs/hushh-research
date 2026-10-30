import { mergeCardScanReadings, parseCardScanReading, type CardScanReading } from "./card-scan-fields";
import { spatialCardNumbers, type CardTextObservation } from "./card-scan-spatial";
import { detectCardRegion } from "./card-scan-region";
import { rasterCanvas, decodeCardPng, flattenCardTransparency, type CardRaster } from "./card-scan-raster";
import { cardProjection, isFullCard, validCardCorners, type CardCorners, type CardImageBox } from "./card-scan-image";

interface OcrLine { text?: string; confidence?: number; bbox: CardImageBox; words?: OcrLine[] }
interface OcrData { text: string; confidence: number; blocks?: { paragraphs?: { lines?: OcrLine[] }[] }[] }
interface OcrWorker { recognize(image: Blob, options?: object, output?: object): Promise<{ data: OcrData }>; setParameters(value: object): Promise<void>; terminate(): Promise<void> }
declare const Tesseract: { createWorker(language: string, mode: number, options: object): Promise<OcrWorker> };
declare function importScripts(...urls: string[]): void;
const scope = self as unknown as { onmessage: ((event: MessageEvent<{ pixels: CardRaster; corners?: CardCorners; artwork?: boolean; prepareOnly?: boolean; detectOnly?: boolean; sanitizeOnly?: boolean; masks?: CardImageBox[] }>) => void) | null; postMessage(value: unknown): void };

const canvas = rasterCanvas;
async function prepare(input: CardRaster, corners?: CardCorners) {
    if (!input.width || !input.height || input.width * input.height > 4_000_000 || input.data.length !== input.width * input.height * 4) throw new Error("Invalid raster");
    flattenCardTransparency(input);
    const source = canvas(input.width, input.height);
    source.context.putImageData(input, 0, 0);
    if (!corners || isFullCard(corners)) return source;
    if (!validCardCorners(corners)) throw new Error("Invalid crop");
    const pixels = source.context.getImageData(0, 0, source.value.width, source.value.height);
    const length = (a: number, b: number) => Math.hypot((corners[a]!.x - corners[b]!.x) * input.width, (corners[a]!.y - corners[b]!.y) * input.height);
    const portrait = length(0, 1) + length(2, 3) < length(1, 2) + length(3, 0);
    const targetWidth = portrait ? 1010 : 1600, targetHeight = portrait ? 1600 : 1010;
    const target = canvas(targetWidth, targetHeight), output = target.context.createImageData(targetWidth, targetHeight);
    for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
      const point = cardProjection(corners, x / (targetWidth - 1), y / (targetHeight - 1));
      const sx = Math.min(pixels.width - 1, Math.max(0, point.x * (pixels.width - 1))), sy = Math.min(pixels.height - 1, Math.max(0, point.y * (pixels.height - 1)));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let channel = 0; channel < 4; channel++) {
        const at = (px: number, py: number) => pixels.data[(py * pixels.width + px) * 4 + channel]!;
        output.data[(y * targetWidth + x) * 4 + channel] = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(Math.min(x0 + 1, pixels.width - 1), y0)) + fy * ((1 - fx) * at(x0, Math.min(y0 + 1, pixels.height - 1)) + fx * at(Math.min(x0 + 1, pixels.width - 1), Math.min(y0 + 1, pixels.height - 1)));
      }
    }
    target.context.putImageData(output, 0, 0); return target;
}
function enhanced(source: ReturnType<typeof canvas>) {
  const { width, height } = source.value, image = source.context.getImageData(0, 0, width, height);
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) { let row = 0; for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    row += Math.round(image.data[i]! * .299 + image.data[i + 1]! * .587 + image.data[i + 2]! * .114);
    integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1]! + row;
  } }
  const radius = Math.max(16, Math.round(Math.min(width, height) / 12));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1), y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1), stride = width + 1;
    const mean = (integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!) / ((x1 - x0) * (y1 - y0));
    const i = (y * width + x) * 4, grey = image.data[i]! * .299 + image.data[i + 1]! * .587 + image.data[i + 2]! * .114;
    const normalized = Math.min(255, grey * 230 / Math.max(1, mean));
    image.data[i] = image.data[i + 1] = image.data[i + 2] = normalized;
  }
  const target = canvas(width, height); target.context.putImageData(image, 0, 0); return target;
}
function rotated(source: ReturnType<typeof canvas>, angle: number) {
  const input = source.value.raster(), quarter = angle % 180 !== 0;
  const target = canvas(quarter ? input.height : input.width, quarter ? input.width : input.height), output = target.value.raster();
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const tx = angle === 90 ? input.height - 1 - y : angle === 180 ? input.width - 1 - x : y;
    const ty = angle === 90 ? x : angle === 180 ? input.height - 1 - y : input.width - 1 - x;
    output.data.set(input.data.subarray((y * input.width + x) * 4, (y * input.width + x) * 4 + 4), (ty * output.width + tx) * 4);
  }
  return target;
}
function observe(data: OcrData): CardTextObservation[] {
  return (data.blocks ?? []).flatMap(block => (block.paragraphs ?? []).flatMap(paragraph => (paragraph.lines ?? []).flatMap(line => line.words?.length ? line.words.map(word => ({ text: word.text ?? "", confidence: word.confidence ?? 0, bbox: word.bbox })) : [{ text: line.text ?? "", confidence: line.confidence ?? 0, bbox: line.bbox }])));
}
function readingFor(data: OcrData, height: number): CardScanReading {
  const observations = observe(data), reading = parseCardScanReading(data.text + "\n" + spatialCardNumbers(observations).join("\n"));
  for (const key of ["pan", "expiry", "cardholderName"] as const) {
    const field = reading.fields[key]; if (!field) continue;
    const matching = observations.filter(item => key === "pan" ? /^\d{3,19}$/.test(item.text.replace(/[\s-]/g, "")) && field.includes(item.text.replace(/[\s-]/g, "")) : field.split(/\s+/).some(word => item.text.includes(word)));
    if (matching.length && matching.some(item => item.confidence < 65)) reading.states[key] = "needs_review";
    if (key === "cardholderName" && matching.length >= 2 && matching.every(item => item.confidence >= 80 && item.bbox.y0 >= height * .45)) reading.states[key] = "recognized";
  }
  return reading;
}
function boxes(data: OcrData): CardImageBox[] {
  return (data.blocks ?? []).flatMap(block => (block.paragraphs ?? []).flatMap(paragraph => (paragraph.lines ?? []).flatMap(line => line.words?.length ? line.words.map(word => word.bbox) : [line.bbox])));
}
function originalBox(box: CardImageBox, angle: number, width: number, height: number): CardImageBox {
  const points = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].map(([x, y]) => angle === 90 ? [y!, height - x!] : angle === 180 ? [width - x!, height - y!] : angle === 270 ? [width - y!, x!] : [x!, y!]);
  return { x0: Math.max(0, Math.min(...points.map(p => p[0]!))), y0: Math.max(0, Math.min(...points.map(p => p[1]!))), x1: Math.min(width, Math.max(...points.map(p => p[0]!))), y1: Math.min(height, Math.max(...points.map(p => p[1]!))) };
}
scope.onmessage = async event => {
  scope.onmessage = null;
  let worker: OcrWorker | undefined;
  try {
    let source = await prepare(event.data.pixels, event.data.corners);
    if (event.data.detectOnly) { scope.postMessage(detectCardRegion(source.value.raster())); return; }
    if (event.data.prepareOnly) { scope.postMessage({ prepared: await source.value.convertToBlob({ type: "image/png" }) }); return; }
    importScripts("/vendor/wallet-ocr/tesseract.min.js");
    // Only public language data is cached by Tesseract, never photos or OCR output.
    worker = await Tesseract.createWorker("eng", 1, { workerPath: "/vendor/wallet-ocr/worker.min.js", corePath: "/vendor/wallet-ocr", langPath: "/vendor/wallet-ocr", cacheMethod: "write", cachePath: "wallet-ocr-eng-v1", workerBlobURL: false, logger: () => {}, errorHandler: () => scope.postMessage({ error: true }) });
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    const passReadings: CardScanReading[] = [];
    let best: CardScanReading = { fields: {}, states: { pan: "missing", expiry: "missing", cardholderName: "missing" } }, bestScore = -1;
    const original = source;
    let geometry: CardImageBox[] = [], complete = false;
    // At most five recognition passes, including four explicit orientations.
    for (const angle of event.data.sanitizeOnly ? [] : [0, 180, 90, 270]) {
      const current = angle ? rotated(original, angle) : original;
      const result = await worker.recognize(await current.value.convertToBlob({ type: "image/png" }), {}, { blocks: true });
      const reading = readingFor(result.data, current.value.height);
      passReadings.push(reading);
      scope.postMessage({ reading: mergeCardScanReadings(passReadings), progress: true });
      const score = (reading.states.pan === "recognized" ? 10 : reading.fields.pan ? 1 : 0) + (reading.states.expiry === "recognized" ? 3 : reading.fields.expiry ? 1 : 0) + (reading.states.cardholderName === "recognized" ? 2 : reading.fields.cardholderName ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = reading; source = current; geometry = boxes(result.data); }
      // A printed, unlabelled name is intentionally a review draft. It must not
      // force four expensive rotations after the correct orientation was read.
      complete = reading.states.pan === "recognized" && reading.states.expiry === "recognized" && Boolean(reading.fields.cardholderName);
      if (complete) break;
      if (reading.states.pan === "recognized" && reading.states.expiry === "recognized") break;
    }
    const readings = [best, ...passReadings];
    if (!complete && !event.data.sanitizeOnly) {
      const result = await worker.recognize(await enhanced(source).value.convertToBlob({ type: "image/png" }), {}, { blocks: true });
      readings.push(readingFor(result.data, source.value.height)); geometry.push(...boxes(result.data));
    }
    const reading = mergeCardScanReadings(readings);
    let sanitized: Blob | undefined, candidate: Blob | undefined;
    // Only offer photo artwork for an owner-confirmed crop. Mask ALL detected
    // text, not just guessed sensitive labels, in a newly encoded raster.
    if ((event.data.artwork && event.data.corners && geometry.length) || event.data.sanitizeOnly) {
      for (const box of event.data.masks ?? []) {
        if (![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite) || box.x0 < 0 || box.y0 < 0 || box.x1 > 1 || box.y1 > 1 || box.x1 <= box.x0 || box.y1 <= box.y0) throw new Error("Invalid mask");
        source.context.fillRect(box.x0 * source.value.width, box.y0 * source.value.height, (box.x1 - box.x0) * source.value.width, (box.y1 - box.y0) * source.value.height);
      }
      // Collect every orientation into ONE coordinate system before masking.
      // Recognition-empty is not a safety assertion: the owner must also inspect
      // and explicitly approve the final encoded raster in the picker.
      for (const angle of [0, 90, 180, 270]) {
        const current = angle ? rotated(source, angle) : source;
        const found = await worker.recognize(await current.value.convertToBlob({ type: "image/png" }), {}, { blocks: true });
        geometry.push(...boxes(found.data).map(box => originalBox(box, angle, source.value.width, source.value.height)));
      }
      source.context.fillStyle = "#171b24";
      for (const box of geometry) source.context.fillRect(Math.max(0, box.x0 - 18), Math.max(0, box.y0 - 18), box.x1 - box.x0 + 36, box.y1 - box.y0 + 36);
      const large = typeof CompressionStream === "function", portrait = source.value.width < source.value.height;
      const w = portrait ? large ? 378 : 284 : large ? 600 : 450, h = portrait ? large ? 600 : 450 : large ? 378 : 284;
      const flattened = canvas(w, h); flattened.context.drawImage(source.value, 0, 0, w, h);
      const encoded = await flattened.value.convertToBlob({ type: "image/png" });
      const decoded = await prepare(await decodeCardPng(encoded));
      let clean = true;
      for (const angle of [0, 90, 180, 270]) {
        const inspection = await worker.recognize(await (angle ? rotated(decoded, angle) : decoded).value.convertToBlob({ type: "image/png" }), {}, { blocks: true });
        if (inspection.data.text.trim()) { clean = false; break; }
      }
      if (encoded.size <= 512 * 1024) { candidate = encoded; if (clean) sanitized = encoded; }
    }
    scope.postMessage({ reading, ...(sanitized ? { sanitized } : {}), ...(candidate ? { candidate } : {}) });
  } catch { scope.postMessage({ error: true }); }
  finally { await worker?.terminate().catch(() => {}); }
};
