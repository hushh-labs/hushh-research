import { describe, expect, it } from "vitest";

import { encodeQrCode, type QrCodeMatrix } from "@/components/wallet-card/qr-code";

/**
 * Published format-information strings for error-correction level M, masks 0-7
 * (ISO/IEC 18004 Annex C). The encoder must reproduce them exactly or no
 * scanner can read the symbol.
 */
const FORMAT_INFORMATION_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
];

/** Published version-information strings for versions 7-10 (ISO/IEC 18004 Annex D). */
const VERSION_INFORMATION = new Map<number, string>([
  [7, "000111110010010100"],
  [8, "001000010110111100"],
  [9, "001001101010011001"],
  [10, "001010010011010011"],
]);

/** Total codewords and level-M block layout, versions 1-10. */
const VERSION_LAYOUT = [
  { total: 26, ecc: 10, blocks: 1 },
  { total: 44, ecc: 16, blocks: 1 },
  { total: 70, ecc: 26, blocks: 1 },
  { total: 100, ecc: 18, blocks: 2 },
  { total: 134, ecc: 24, blocks: 2 },
  { total: 172, ecc: 16, blocks: 4 },
  { total: 196, ecc: 18, blocks: 4 },
  { total: 242, ecc: 22, blocks: 4 },
  { total: 292, ecc: 22, blocks: 5 },
  { total: 346, ecc: 26, blocks: 5 },
];

function isDark(matrix: QrCodeMatrix, x: number, y: number): boolean {
  return (matrix.modules[y * matrix.size + x] ?? 0) === 1;
}

function versionOf(matrix: QrCodeMatrix): number {
  return (matrix.size - 17) / 4;
}

/** Bit `index` of the first format copy, which wraps the top-left finder. */
function firstFormatCopyPosition(index: number): { x: number; y: number } {
  if (index <= 5) return { x: 8, y: index };
  if (index === 6) return { x: 8, y: 7 };
  if (index === 7) return { x: 8, y: 8 };
  if (index === 8) return { x: 7, y: 8 };
  return { x: 14 - index, y: 8 };
}

/** Bit `index` of the second format copy, split across bottom-left and top-right. */
function secondFormatCopyPosition(index: number, size: number): { x: number; y: number } {
  if (index < 8) return { x: size - 1 - index, y: 8 };
  return { x: 8, y: size - 15 + index };
}

function readFormatInformation(matrix: QrCodeMatrix, copy: "first" | "second"): string {
  const bits: string[] = [];
  for (let index = 0; index < 15; index += 1) {
    const { x, y } =
      copy === "first"
        ? firstFormatCopyPosition(index)
        : secondFormatCopyPosition(index, matrix.size);
    bits.push(isDark(matrix, x, y) ? "1" : "0");
  }
  return bits.reverse().join("");
}

function readVersionInformation(matrix: QrCodeMatrix, copy: "top" | "left"): string {
  const bits: string[] = [];
  for (let index = 0; index < 18; index += 1) {
    const far = matrix.size - 11 + (index % 3);
    const near = Math.floor(index / 3);
    const x = copy === "top" ? far : near;
    const y = copy === "top" ? near : far;
    bits.push(isDark(matrix, x, y) ? "1" : "0");
  }
  return bits.reverse().join("");
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

/** Independent reconstruction of which modules are function patterns. */
function functionModuleGrid(size: number, version: number): Uint8Array {
  const grid = new Uint8Array(size * size);
  const mark = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    grid[y * size + x] = 1;
  };

  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark((cx ?? 0) + dx, (cy ?? 0) + dy);
    }
  }

  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          mark((positions[i] ?? 0) + dx, (positions[j] ?? 0) + dy);
        }
      }
    }
  }

  for (let index = 0; index < 15; index += 1) {
    const first = firstFormatCopyPosition(index);
    mark(first.x, first.y);
    const second = secondFormatCopyPosition(index, size);
    mark(second.x, second.y);
  }
  mark(8, size - 8);

  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const far = size - 11 + (index % 3);
      const near = Math.floor(index / 3);
      mark(far, near);
      mark(near, far);
    }
  }
  return grid;
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

/**
 * Reads the payload back out of a finished symbol: recover the mask from the
 * format bits, unmask, walk the zig-zag, de-interleave the blocks, and parse
 * the byte-mode header. Error correction is not applied — an undamaged symbol
 * must decode from its data codewords alone.
 */
function decodePayload(matrix: QrCodeMatrix): string {
  const size = matrix.size;
  const version = versionOf(matrix);
  const layout = VERSION_LAYOUT[version - 1];
  if (!layout) throw new Error(`Unsupported version ${version}`);

  const mask = FORMAT_INFORMATION_M.indexOf(readFormatInformation(matrix, "first"));
  if (mask < 0) throw new Error("Format information is not a published value");

  const functionModules = functionModuleGrid(size, version);
  const totalBits = layout.total * 8;
  const bits: number[] = [];
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if ((functionModules[y * size + x] ?? 0) === 1) continue;
        if (bits.length >= totalBits) continue;
        bits.push((isDark(matrix, x, y) ? 1 : 0) ^ (maskCondition(mask, x, y) ? 1 : 0));
      }
    }
    right -= 2;
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }

  const dataLength = layout.total - layout.ecc * layout.blocks;
  const shortLength = Math.floor(dataLength / layout.blocks);
  const longCount = dataLength % layout.blocks;
  const blockLengths: number[] = [];
  for (let i = 0; i < layout.blocks; i += 1) {
    blockLengths.push(shortLength + (i >= layout.blocks - longCount ? 1 : 0));
  }
  const blocks: number[][] = blockLengths.map(() => []);
  let cursor = 0;
  for (let i = 0; i < shortLength + (longCount > 0 ? 1 : 0); i += 1) {
    for (let block = 0; block < layout.blocks; block += 1) {
      if (i < (blockLengths[block] ?? 0)) {
        blocks[block]?.push(codewords[cursor] ?? 0);
        cursor += 1;
      }
    }
  }

  const stream = blocks
    .flat()
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("");
  expect(parseInt(stream.slice(0, 4), 2)).toBe(0b0100);
  const countBits = version < 10 ? 8 : 16;
  const length = parseInt(stream.slice(4, 4 + countBits), 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = 4 + countBits + i * 8;
    bytes[i] = parseInt(stream.slice(start, start + 8), 2);
  }
  return new TextDecoder().decode(bytes);
}

const SHARE_LINK = "https://one.hushh.ai/c/x1Y2z3A4b5C6d7E8f9G0h1I2j3K4l5M6n7O8p9Q";

describe("wallet-card QR encoder", () => {
  it("sizes the symbol from the payload length", () => {
    // Level-M byte capacity: version 1 holds 14 bytes, version 2 holds 26.
    expect(encodeQrCode("a".repeat(14)).size).toBe(21);
    expect(encodeQrCode("a".repeat(15)).size).toBe(25);
    expect(encodeQrCode("a".repeat(26)).size).toBe(25);
    // A realistic share link fits inside version 4.
    expect(encodeQrCode(SHARE_LINK).size).toBe(33);
  });

  it("writes the published format information into both copies", () => {
    const matrix = encodeQrCode(SHARE_LINK);
    const first = readFormatInformation(matrix, "first");
    expect(FORMAT_INFORMATION_M).toContain(first);
    expect(readFormatInformation(matrix, "second")).toBe(first);
  });

  it("writes the published version information for versions 7 and above", () => {
    for (const [version, expected] of VERSION_INFORMATION) {
      const payloads: Record<number, number> = { 7: 122, 8: 152, 9: 180, 10: 213 };
      const matrix = encodeQrCode("x".repeat(payloads[version] ?? 0));
      expect(versionOf(matrix)).toBe(version);
      expect(readVersionInformation(matrix, "top")).toBe(expected);
      expect(readVersionInformation(matrix, "left")).toBe(expected);
    }
  });

  it("places all three finder patterns", () => {
    const matrix = encodeQrCode(SHARE_LINK);
    for (const [originX, originY] of [
      [0, 0],
      [matrix.size - 7, 0],
      [0, matrix.size - 7],
    ]) {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(isDark(matrix, (originX ?? 0) + dx, (originY ?? 0) + dy)).toBe(ring !== 2);
        }
      }
    }
  });

  it("draws the timing patterns and the always-dark module", () => {
    const matrix = encodeQrCode(SHARE_LINK);
    for (let i = 8; i < matrix.size - 8; i += 1) {
      expect(isDark(matrix, 6, i)).toBe(i % 2 === 0);
      expect(isDark(matrix, i, 6)).toBe(i % 2 === 0);
    }
    expect(isDark(matrix, 8, matrix.size - 8)).toBe(true);
  });

  it("round-trips payloads across every supported version", () => {
    const samples = [
      SHARE_LINK,
      "https://one.hushh.ai/c/DEMOTOKEN",
      "a".repeat(14),
      "a".repeat(15),
      "b".repeat(62),
      "c".repeat(84),
      "d".repeat(107),
      "e".repeat(152),
      "f".repeat(180),
      "g".repeat(213),
      "héllo wörld",
    ];
    for (const sample of samples) {
      expect(decodePayload(encodeQrCode(sample))).toBe(sample);
    }
  });

  it("rejects payloads beyond the supported capacity", () => {
    expect(() => encodeQrCode("x".repeat(214))).toThrow(/too long/i);
  });
});
