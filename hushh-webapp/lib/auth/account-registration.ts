/** Recovery is identity-scoped; none of these states admits application information. */
export type AccountRegistrationReview = Readonly<{
  previous_generation: number;
  cleanup_operation: string;
  enrollment_operation: string;
  expires_at: number;
  terms_version: 1;
  digest: string;
}>;

export type AccountRegistrationRecovery =
  | { state: "ready"; review: AccountRegistrationReview }
  | { state: "waiting_for_identity"; retry_at: number }
  | { state: "fresh_identity_required" }
  | { state: "cleanup_pending"; reason: "cleanup_in_progress" }
  | { state: "action_required"; reason: "historical_cleanup_unconfirmed" | "identity_write_unconfirmed" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseAccountRegistrationRecovery(value: unknown): AccountRegistrationRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state === "fresh_identity_required") return { state: record.state };
  if (record.state === "cleanup_pending" && record.reason === "cleanup_in_progress")
    return { state: record.state, reason: record.reason };
  if (record.state === "action_required" && (record.reason === "historical_cleanup_unconfirmed" || record.reason === "identity_write_unconfirmed"))
    return { state: record.state, reason: record.reason };
  if (record.state === "waiting_for_identity" && Number.isSafeInteger(record.retry_at) && (record.retry_at as number) > 0)
    return { state: record.state, retry_at: record.retry_at as number };
  if (record.state !== "ready" || !record.review || typeof record.review !== "object" || Array.isArray(record.review)) return null;
  const review = record.review as AccountRegistrationReview;
  if (!Number.isSafeInteger(review.previous_generation) || review.previous_generation < 0
      || typeof review.cleanup_operation !== "string" || !UUID.test(review.cleanup_operation)
      || typeof review.enrollment_operation !== "string" || !UUID.test(review.enrollment_operation)
      || !Number.isSafeInteger(review.expires_at) || review.expires_at <= 0
      || review.terms_version !== 1 || typeof review.digest !== "string" || !/^[0-9a-f]{64}$/.test(review.digest)) return null;
  return { state: "ready", review: { previous_generation: review.previous_generation,
    cleanup_operation: review.cleanup_operation, enrollment_operation: review.enrollment_operation,
    expires_at: review.expires_at, terms_version: 1, digest: review.digest } };
}
