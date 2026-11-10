export interface CloudCleanupSummary {
  state: "pending" | "completed";
  operation_id: string;
  next_check_at: string | null;
  owner_action_required: boolean;
}

export function validCloudCleanupSummary(value: unknown): value is CloudCleanupSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v.state === "pending" || v.state === "completed") &&
    typeof v.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v.operation_id) &&
    typeof v.owner_action_required === "boolean" &&
    (v.next_check_at === null || (typeof v.next_check_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(v.next_check_at) && Number.isFinite(Date.parse(v.next_check_at)))) &&
    (v.state !== "completed" || (v.next_check_at === null && v.owner_action_required === false));
}

/** Non-secret aggregate from the purpose-bound account cleanup authority. */
export interface AccountCleanupOperation {
  id: string;
  owner_id?: string | null;
  owner_hash?: string;
  state: "cleaning_up" | "waiting_for_provider" | "action_required" | "complete";
  credential_count: number;
  local_erasure_confirmation_required: boolean;
  external_validity_unconfirmed_count: number;
  inventory_sha256: string;
  retry_after_seconds: number | null;
  /** Additive: due work has waited past the backend's stall window. Older backends omit it. */
  delayed?: boolean;
  /** Native identity absence and local erasure both settled. Legacy backends omit it. */
  identity_removed?: boolean;
  account_deleted?: boolean;
  ready_to_start_fresh?: boolean;
  cloud_cleanup?: CloudCleanupSummary;
}

export function parseAccountCleanupOperation(value: unknown): AccountCleanupOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation.id) ||
    (operation.owner_id != null && (typeof operation.owner_id !== "string" || !operation.owner_id || operation.owner_id.length > 128)) ||
    (operation.owner_hash !== undefined && (typeof operation.owner_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(operation.owner_hash))) ||
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
    (operation.delayed !== undefined && typeof operation.delayed !== "boolean") ||
    (operation.cloud_cleanup !== undefined && !validCloudCleanupSummary(operation.cloud_cleanup)) ||
    (operation.account_deleted !== undefined && typeof operation.account_deleted !== "boolean") ||
    (operation.ready_to_start_fresh !== undefined && typeof operation.ready_to_start_fresh !== "boolean") ||
    (operation.account_deleted === true && (operation.state !== "complete" || operation.identity_removed !== true)) ||
    (operation.ready_to_start_fresh === true && operation.account_deleted !== true) ||
    (operation.identity_removed !== undefined && typeof operation.identity_removed !== "boolean")
  ) return null;
  return operation as unknown as AccountCleanupOperation;
}
