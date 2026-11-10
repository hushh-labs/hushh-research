const RECOVERY_KEY_RANDOM_BYTES = 16;

/** Format all 128 generated random bits into a human-readable recovery key. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.byteLength !== RECOVERY_KEY_RANDOM_BYTES) {
    throw new RangeError("Recovery keys require 128 random bits.");
  }

  const groups: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    groups.push(
      Array.from(bytes.subarray(offset, offset + 2), (byte) =>
        byte.toString(16).padStart(2, "0"),
      )
        .join("")
        .toUpperCase(),
    );
  }

  return `HRK-${groups.join("-")}`;
}

export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_RANDOM_BYTES));
  try {
    return formatRecoveryKey(bytes);
  } finally {
    bytes.fill(0);
  }
}
