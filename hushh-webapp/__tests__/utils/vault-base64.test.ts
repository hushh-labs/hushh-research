import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

describe("vault base64 helpers", () => {
  it("decodes padded base64 without corrupting payload bytes", () => {
    const input = "Yg==";

    const decoded = base64ToBytes(input);

    expect(Array.from(decoded)).toEqual([98]);
    expect(bytesToBase64(decoded)).toBe(input);
  });
});
