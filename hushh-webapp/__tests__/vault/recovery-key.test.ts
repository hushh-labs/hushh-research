import { formatRecoveryKey, generateRecoveryKey } from "@/lib/vault/recovery-key";

describe("Vault recovery key", () => {
  it("formats all 128 random bits into eight groups", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);

    expect(formatRecoveryKey(bytes)).toBe(
      "HRK-0001-0203-0405-0607-0809-0A0B-0C0D-0E0F",
    );
  });

  it("generates the full 128-bit recovery-key shape", () => {
    const recoveryKey = generateRecoveryKey();
    const groups = recoveryKey.slice("HRK-".length).split("-");

    expect(groups).toHaveLength(8);
    expect(groups.every((group) => /^[0-9A-F]{4}$/.test(group))).toBe(true);
  });

  it("rejects truncated or oversized random input", () => {
    expect(() => formatRecoveryKey(new Uint8Array(8))).toThrow(
      "Recovery keys require 128 random bits.",
    );
    expect(() => formatRecoveryKey(new Uint8Array(17))).toThrow(
      "Recovery keys require 128 random bits.",
    );
  });
});
