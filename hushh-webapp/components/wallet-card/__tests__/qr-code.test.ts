import { describe, expect, it } from "vitest";
import { encodeQrCode } from "@/components/wallet-card/qr-code";
import { FORMAT_INFORMATION_M, VERSION_INFORMATION, readFormatInformation, readVersionInformation, versionOf, isDark, decodePayload } from "./qr-code-test-decoder";

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
