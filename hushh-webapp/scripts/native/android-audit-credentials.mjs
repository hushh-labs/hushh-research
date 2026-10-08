import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export function createAndroidCredentialRunId() {
  return randomUUID();
}

export function encodeAndroidAuditCredentials({ runId, reviewerUid, reviewerVaultPassphrase }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId || "")) {
    throw new Error("Invalid native audit credential session.");
  }
  const parts = [Buffer.from("HUSHHN1\n", "ascii")];
  for (const [value, limit] of [[runId, 36], [reviewerUid, 512], [reviewerVaultPassphrase, 4096]]) {
    if (typeof value !== "string") throw new Error("Invalid native audit credential frame.");
    const bytes = Buffer.from(value, "utf8");
    if (!bytes.length || bytes.length > limit) throw new Error("Invalid native audit credential frame.");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

export function deliverAndroidAuditCredentials({ adb, serial, runId, reviewerUid, reviewerVaultPassphrase, execute = execFileSync }) {
  const frame = encodeAndroidAuditCredentials({ runId, reviewerUid, reviewerVaultPassphrase });
  try {
    const output = execute(adb, [
      "-s", serial, "shell", "-T", "run-as", "com.hussh.app", "toybox", "nc",
      "-U", "-w", "5", "-W", "5", `cache/native-audit-${runId}.sock`,
    ], { input: frame, timeout: 10_000, maxBuffer: 1024, stdio: ["pipe", "pipe", "pipe"] });
    if (String(output).trim() !== "accepted") throw new Error("refused");
  } catch {
    // Never propagate subprocess objects, argv, captured buffers or payloads.
    throw new Error("Android native audit credential delivery failed.");
  } finally {
    frame.fill(0);
  }
}
