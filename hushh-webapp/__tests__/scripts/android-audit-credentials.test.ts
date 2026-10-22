// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAndroidCredentialRunId, deliverAndroidAuditCredentials, encodeAndroidAuditCredentials } from "../../scripts/native/android-audit-credentials.mjs";

const credentials = {
  runId: "ce2a360b-8dac-4ab0-8f84-e3e7f17d3d88",
  reviewerUid: "synthetic-reviewer",
  reviewerVaultPassphrase: "synthetic passphrase\nwith unicode 🔐",
};

describe("Android audit credential transport", () => {
  it("encodes bounded typed fields without losing whitespace or unicode", () => {
    const frame = encodeAndroidAuditCredentials(credentials);
    expect(frame.subarray(0, 8).toString("ascii")).toBe("HUSHHN1\n");
    let offset = 8;
    for (const expected of Object.values(credentials)) {
      const length = frame.readUInt32BE(offset);
      offset += 4;
      expect(frame.subarray(offset, offset + length).toString("utf8")).toBe(expected);
      offset += length;
    }
    expect(offset).toBe(frame.length);
    expect(createAndroidCredentialRunId()).not.toBe(createAndroidCredentialRunId());
  });

  it.each([
    { runId: "../other-socket" },
    { reviewerUid: "" },
    { reviewerUid: "x".repeat(513) },
    { reviewerVaultPassphrase: "" },
    { reviewerVaultPassphrase: "🔐".repeat(1025) },
  ])("refuses malformed or oversized frames before starting any subprocess", (invalid) => {
    const execute = vi.fn();
    expect(() => deliverAndroidAuditCredentials({ adb: "adb", serial: "fixture", ...credentials, ...invalid, execute })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses run-as stdin only and clears the submitted buffer after completion", () => {
    let submitted: Buffer | undefined;
    const execute = vi.fn((_command, args, options) => {
      expect(args).toContain("run-as");
      expect(args).toContain("-T");
      expect(args).toContain("com.hussh.app");
      expect(args.join(" ")).not.toContain(credentials.reviewerUid);
      expect(args.join(" ")).not.toContain(credentials.reviewerVaultPassphrase);
      expect(options.input.equals(encodeAndroidAuditCredentials(credentials))).toBe(true);
      submitted = options.input;
      return Buffer.from("accepted\n");
    });
    deliverAndroidAuditCredentials({ adb: "adb", serial: "fixture", ...credentials, execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(submitted?.every((byte) => byte === 0)).toBe(true);
  });

  it.each([false, true])("keeps refusal and subprocess failures value-free", (throws) => {
    const execute = () => {
      if (throws) throw new Error(credentials.reviewerVaultPassphrase);
      return Buffer.from(credentials.reviewerVaultPassphrase);
    };
    expect(() => deliverAndroidAuditCredentials({ adb: "adb", serial: "fixture", ...credentials, execute })).toThrow(/^Android native audit credential delivery failed\.$/);
  });
});
