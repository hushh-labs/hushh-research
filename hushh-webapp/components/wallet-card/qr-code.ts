/**
 * Self-contained QR Code encoder for the Wallet Profile share link.
 *
 * Scope is deliberately narrow: byte mode, error-correction level M, versions
 * 1-10 (up to 213 bytes), automatic mask selection. That is far more than a
 * share URL needs and keeps the tables small.
 *
 * This lives in the repo instead of a dependency because the Wallet Profile is
 * the only QR surface in the product and the encoder must run offline inside
 * the native WebView. It renders the owner's own share URL; nothing here ever
 * touches vault material.
 */

/** A finished QR symbol. `isDark(x, y)` reads a module; origin is top-left. */
export interface QrCodeMatrix {
  /** Module count per side, excluding the quiet zone. */
  readonly size: number;
  /** Row-major dark-module flags, length `size * size`. */
  readonly modules: Uint8Array;
}

interface QrVersionSpec {
  /** Total codewords (data + error correction) for the version. */
  readonly totalCodewords: number;
  /** Error-correction codewords per block at level M. */
  readonly eccPerBlock: number;
  /** Number of interleaved blocks at level M. */
  readonly blocks: number;
}

/** Versions 1-10 at error-correction level M. */
const VERSION_SPECS: readonly QrVersionSpec[] = [
  { totalCodewords: 26, eccPerBlock: 10, blocks: 1 },
  { totalCodewords: 44, eccPerBlock: 16, blocks: 1 },
  { totalCodewords: 70, eccPerBlock: 26, blocks: 1 },
  { totalCodewords: 100, eccPerBlock: 18, blocks: 2 },
  { totalCodewords: 134, eccPerBlock: 24, blocks: 2 },
  { totalCodewords: 172, eccPerBlock: 16, blocks: 4 },
  { totalCodewords: 196, eccPerBlock: 18, blocks: 4 },
  { totalCodewords: 242, eccPerBlock: 22, blocks: 4 },
  { totalCodewords: 292, eccPerBlock: 22, blocks: 5 },
  { totalCodewords: 346, eccPerBlock: 26, blocks: 5 },
];

/** Level M is `00` in the two-bit error-correction indicator. */
const ECC_LEVEL_M_BITS = 0b00;
const BYTE_MODE_INDICATOR = 0b0100;
const PAD_BYTES = [0xec, 0x11] as const;

// ---------------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11D)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
})();

function gfExp(index: number): number {
  return GF_EXP[index] ?? 0;
}

function gfLog(value: number): number {
  return GF_LOG[value] ?? 0;
}

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return gfExp(gfLog(left) + gfLog(right));
}

/** Reed-Solomon generator polynomial of the given degree, highest term first. */
function generatorPolynomial(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const coefficient = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(coefficient, gfExp(i));
    }
    poly = next;
  }
  return poly;
}

/** Error-correction codewords for one data block. */
function errorCorrectionCodewords(data: Uint8Array, degree: number): Uint8Array {
  const generator = generatorPolynomial(degree);
  const remainder = new Uint8Array(degree);
  for (let index = 0; index < data.length; index += 1) {
    const factor = (data[index] ?? 0) ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Bit stream
// ---------------------------------------------------------------------------

class BitBuffer {
  private readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  padToByteBoundary(): void {
    while (this.bits.length % 8 !== 0) {
      this.bits.push(0);
    }
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i += 1) {
      if ((this.bits[i] ?? 0) === 1) {
        const byteIndex = Math.floor(i / 8);
        bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (0x80 >>> i % 8);
      }
    }
    return bytes;
  }
}

function characterCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function versionSpec(version: number): QrVersionSpec {
  const spec = VERSION_SPECS[version - 1];
  if (!spec) {
    throw new Error(`Unsupported QR version: ${version}`);
  }
  return spec;
}

function dataCodewordCount(version: number): number {
  const spec = versionSpec(version);
  return spec.totalCodewords - spec.eccPerBlock * spec.blocks;
}

/** Smallest supported version that fits `byteLength` bytes at level M. */
function selectVersion(byteLength: number): number {
  for (let version = 1; version <= VERSION_SPECS.length; version += 1) {
    const capacityBits = dataCodewordCount(version) * 8;
    const requiredBits = 4 + characterCountBits(version) + byteLength * 8;
    if (requiredBits <= capacityBits) {
      return version;
    }
  }
  throw new Error("Value is too long to encode as a QR code");
}

/** Mode + length header, payload, terminator, and pad bytes. */
function buildDataCodewords(payload: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewordCount(version);
  const buffer = new BitBuffer();
  buffer.append(BYTE_MODE_INDICATOR, 4);
  buffer.append(payload.length, characterCountBits(version));
  for (const byte of payload) {
    buffer.append(byte, 8);
  }

  const capacityBits = capacity * 8;
  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  buffer.padToByteBoundary();

  const bytes = buffer.toBytes();
  const codewords = new Uint8Array(capacity);
  codewords.set(bytes.subarray(0, capacity));
  for (let i = bytes.length; i < capacity; i += 1) {
    codewords[i] = PAD_BYTES[(i - bytes.length) % 2] ?? 0;
  }
  return codewords;
}

/** Split into blocks, add error correction, and interleave per the spec. */
function buildFinalCodewords(dataCodewords: Uint8Array, version: number): Uint8Array {
  const spec = versionSpec(version);
  const shortBlockLength = Math.floor(dataCodewords.length / spec.blocks);
  const longBlockCount = dataCodewords.length % spec.blocks;

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let block = 0; block < spec.blocks; block += 1) {
    const length = shortBlockLength + (block >= spec.blocks - longBlockCount ? 1 : 0);
    const data = dataCodewords.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(data);
    eccBlocks.push(errorCorrectionCodewords(data, spec.eccPerBlock));
  }

  const result = new Uint8Array(spec.totalCodewords);
  let cursor = 0;
  const longestData = shortBlockLength + (longBlockCount > 0 ? 1 : 0);
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        result[cursor] = block[i] ?? 0;
        cursor += 1;
      }
    }
  }
  for (let i = 0; i < spec.eccPerBlock; i += 1) {
    for (const block of eccBlocks) {
      result[cursor] = block[i] ?? 0;
      cursor += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Symbol layout
// ---------------------------------------------------------------------------

class QrCanvas {
  readonly size: number;
  readonly dark: Uint8Array;
  readonly reserved: Uint8Array;

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.reserved = new Uint8Array(this.size * this.size);
  }

  private index(x: number, y: number): number {
    return y * this.size + x;
  }

  isDark(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return false;
    return (this.dark[this.index(x, y)] ?? 0) === 1;
  }

  isReserved(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return true;
    return (this.reserved[this.index(x, y)] ?? 0) === 1;
  }

  setModule(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.dark[this.index(x, y)] = dark ? 1 : 0;
  }

  setFunctionModule(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.dark[this.index(x, y)] = dark ? 1 : 0;
    this.reserved[this.index(x, y)] = 1;
  }
}

function getBit(value: number, position: number): boolean {
  return ((value >>> position) & 1) !== 0;
}

function alignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

function drawFinderPattern(canvas: QrCanvas, centerX: number, centerY: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      canvas.setFunctionModule(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(canvas: QrCanvas, centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      canvas.setFunctionModule(
        centerX + dx,
        centerY + dy,
        Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
      );
    }
  }
}

/** 15-bit BCH format information for level M and the given mask. */
function formatInformationBits(mask: number): number {
  const data = (ECC_LEVEL_M_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormatBits(canvas: QrCanvas, mask: number): void {
  const bits = formatInformationBits(mask);
  const size = canvas.size;

  for (let i = 0; i <= 5; i += 1) {
    canvas.setFunctionModule(8, i, getBit(bits, i));
  }
  canvas.setFunctionModule(8, 7, getBit(bits, 6));
  canvas.setFunctionModule(8, 8, getBit(bits, 7));
  canvas.setFunctionModule(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) {
    canvas.setFunctionModule(14 - i, 8, getBit(bits, i));
  }

  for (let i = 0; i < 8; i += 1) {
    canvas.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
  }
  for (let i = 8; i < 15; i += 1) {
    canvas.setFunctionModule(8, size - 15 + i, getBit(bits, i));
  }
  canvas.setFunctionModule(8, size - 8, true);
}

/** 18-bit BCH version information, drawn only for versions 7 and above. */
function drawVersionBits(canvas: QrCanvas, version: number): void {
  if (version < 7) return;
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const far = canvas.size - 11 + (i % 3);
    const near = Math.floor(i / 3);
    canvas.setFunctionModule(far, near, bit);
    canvas.setFunctionModule(near, far, bit);
  }
}

function drawFunctionPatterns(canvas: QrCanvas, version: number): void {
  const size = canvas.size;

  for (let i = 0; i < size; i += 1) {
    canvas.setFunctionModule(6, i, i % 2 === 0);
    canvas.setFunctionModule(i, 6, i % 2 === 0);
  }

  drawFinderPattern(canvas, 3, 3);
  drawFinderPattern(canvas, size - 4, 3);
  drawFinderPattern(canvas, 3, size - 4);

  const positions = alignmentPatternPositions(version, size);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const skipsFinder =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (skipsFinder) continue;
      drawAlignmentPattern(canvas, positions[i] ?? 0, positions[j] ?? 0);
    }
  }

  drawFormatBits(canvas, 0);
  drawVersionBits(canvas, version);
}

/** Zig-zag placement of the interleaved codewords into the free modules. */
function drawCodewords(canvas: QrCanvas, codewords: Uint8Array): void {
  const size = canvas.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;

  // Column pairs run right-to-left. Column 6 is the vertical timing pattern, so
  // the pair index shifts down to 5 and every later pair follows from there.
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) {
      right = 5;
    }
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (canvas.isReserved(x, y) || bitIndex >= totalBits) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        canvas.setModule(x, y, getBit(byte, 7 - (bitIndex & 7)));
        bitIndex += 1;
      }
    }
    right -= 2;
  }
}

function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(canvas: QrCanvas, mask: number): void {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      if (canvas.isReserved(x, y)) continue;
      if (!maskCondition(mask, x, y)) continue;
      canvas.setModule(x, y, !canvas.isDark(x, y));
    }
  }
}

const FINDER_LIKE_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_B = [false, false, false, false, true, false, true, true, true, false, true];

function matchesFinderLike(line: boolean[], start: number, pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (line[start + i] !== pattern[i]) return false;
  }
  return true;
}

function linePenalty(line: boolean[]): number {
  let penalty = 0;
  let runLength = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength += 1;
      continue;
    }
    if (runLength >= 5) {
      penalty += 3 + (runLength - 5);
    }
    runLength = 1;
  }
  for (let i = 0; i + FINDER_LIKE_A.length <= line.length; i += 1) {
    if (matchesFinderLike(line, i, FINDER_LIKE_A) || matchesFinderLike(line, i, FINDER_LIKE_B)) {
      penalty += 40;
    }
  }
  return penalty;
}

function maskPenalty(canvas: QrCanvas): number {
  const size = canvas.size;
  let penalty = 0;

  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) row.push(canvas.isDark(x, y));
    penalty += linePenalty(row);
  }
  for (let x = 0; x < size; x += 1) {
    const column: boolean[] = [];
    for (let y = 0; y < size; y += 1) column.push(canvas.isDark(x, y));
    penalty += linePenalty(column);
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = canvas.isDark(x, y);
      if (
        value === canvas.isDark(x + 1, y) &&
        value === canvas.isDark(x, y + 1) &&
        value === canvas.isDark(x + 1, y + 1)
      ) {
        penalty += 3;
      }
    }
  }

  let darkCount = 0;
  for (let i = 0; i < canvas.dark.length; i += 1) {
    darkCount += canvas.dark[i] ?? 0;
  }
  const total = size * size;
  const deviation = Math.abs(darkCount * 20 - total * 10);
  penalty += Math.floor(deviation / total) * 10;

  return penalty;
}

/**
 * Encode `value` as a QR symbol (byte mode, level M).
 *
 * Throws when the value exceeds version 10 capacity (213 bytes), which a share
 * URL never does.
 */
export function encodeQrCode(value: string): QrCodeMatrix {
  const payload = new TextEncoder().encode(value);
  const version = selectVersion(payload.length);
  const codewords = buildFinalCodewords(buildDataCodewords(payload, version), version);

  let best: QrCanvas | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const canvas = new QrCanvas(version);
    drawFunctionPatterns(canvas, version);
    drawCodewords(canvas, codewords);
    drawFormatBits(canvas, mask);
    applyMask(canvas, mask);
    const penalty = maskPenalty(canvas);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = canvas;
    }
  }

  if (!best) {
    throw new Error("QR encoding failed");
  }
  return { size: best.size, modules: best.dark };
}
