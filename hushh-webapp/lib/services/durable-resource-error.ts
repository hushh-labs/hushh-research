export type DurableResourceStage = "version" | "authority" | "schema" | "encryption" | "write" | "readback" | "commit";
export type DurableResourceCode = "storage_unavailable" | "transaction_failed" | "quota_exceeded" | "key_unavailable" | "authority_changed" | "stale_version" | "binding_invalid" | "schema_invalid" | "capacity_exceeded" | "encryption_failed" | "readback_failed";

/** Fixed metadata only: never include receipt values, account IDs or key material. */
export class DurableResourceError extends Error {
  readonly name = "DurableResourceError";
  constructor(readonly code: DurableResourceCode, readonly stage: DurableResourceStage, message: string) {
    super(message);
  }
}

export function durableResourceError(error: unknown, stage: DurableResourceStage): DurableResourceError {
  if (error instanceof DurableResourceError) return error;
  const quota = typeof error === "object" && error !== null && "name" in error && error.name === "QuotaExceededError";
  return new DurableResourceError(quota ? "quota_exceeded" : stage === "schema" ? "schema_invalid" : stage === "encryption" ? "encryption_failed" : stage === "readback" ? "readback_failed" : "transaction_failed", stage,
    "Encrypted receipt storage failed. Existing saved receipts were kept.");
}
