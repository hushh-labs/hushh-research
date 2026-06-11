import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

describe("vault base64 helpers", () => {
  it("round-trips bytes across the encoder chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    const encoded = bytesToBase64(bytes);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(bytes);
  });
});
