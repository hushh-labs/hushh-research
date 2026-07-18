import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

describe("base64 utilities", () => {
  it("encodes an empty array", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("decodes an empty string", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("encodes ASCII bytes to base64", () => {
    const bytes = new TextEncoder().encode("hello");

    expect(bytesToBase64(bytes)).toBe("aGVsbG8=");
  });

  it("decodes base64 to the original bytes", () => {
    const decoded = base64ToBytes("aGVsbG8=");

    expect(new TextDecoder().decode(decoded)).toBe("hello");
  });

  it("round-trips arbitrary binary data", () => {
    const original = Uint8Array.from([
      0,
      1,
      2,
      3,
      127,
      128,
      200,
      255,
    ]);

    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);

    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("round-trips a large byte array", () => {
    const original = Uint8Array.from(
      { length: 100000 },
      (_, index) => index % 256,
    );

    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(original);
  });
});
