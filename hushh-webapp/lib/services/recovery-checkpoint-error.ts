/** A recovery checkpoint that cannot be read now: past its retention by this
 * device's clock, or not decryptable or parseable under this vault key.
 * Storage failures and a clock behind the write time stay plain, retryable
 * errors. Fixed metadata only: never include checkpoint values, account IDs or keys. */
export class RecoveryCheckpointUnreadableError extends Error {
  readonly name = "RecoveryCheckpointUnreadableError";
  constructor(readonly reason: "expired" | "unreadable") {
    super("The encrypted recovery checkpoint needs review.");
  }
}
