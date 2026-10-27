/** Non-secret aggregate from the purpose-bound account cleanup authority. */
export interface AccountCleanupOperation {
  id: string;
  state: "cleaning_up" | "waiting_for_provider" | "action_required" | "complete";
  credential_count: number;
  local_erasure_confirmation_required: boolean;
  external_validity_unconfirmed_count: number;
  inventory_sha256: string;
  retry_after_seconds: number | null;
  /** Additive: due work has waited past the backend's stall window. Older backends omit it. */
  delayed?: boolean;
}

export function parseAccountCleanupOperation(value: unknown): AccountCleanupOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation.id) ||
    typeof operation.state !== "string" || !["cleaning_up", "waiting_for_provider", "action_required", "complete"].includes(operation.state) ||
    typeof operation.credential_count !== "number" || !Number.isInteger(operation.credential_count) ||
    operation.credential_count < 0 || operation.credential_count > 128 ||
    typeof operation.local_erasure_confirmation_required !== "boolean" ||
    typeof operation.external_validity_unconfirmed_count !== "number" ||
    !Number.isInteger(operation.external_validity_unconfirmed_count) ||
    operation.external_validity_unconfirmed_count < 0 ||
    operation.external_validity_unconfirmed_count > operation.credential_count ||
    typeof operation.inventory_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(operation.inventory_sha256) ||
    (operation.retry_after_seconds !== null &&
      (typeof operation.retry_after_seconds !== "number" ||
        !Number.isInteger(operation.retry_after_seconds) || operation.retry_after_seconds < 1 || operation.retry_after_seconds > 60)) ||
    (operation.delayed !== undefined && typeof operation.delayed !== "boolean")
  ) return null;
  return operation as unknown as AccountCleanupOperation;
}
