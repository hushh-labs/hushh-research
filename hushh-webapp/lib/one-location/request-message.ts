/**
 * Builds the single request.message value stored by One Location.
 *
 * The Ask flow exposes "Reason" and "Message" as separate UI fields, while the
 * existing request API persists one optional message string. Keep that storage
 * contract stable and compose the two fields deterministically.
 */
export function buildOneLocationRequestMessage(
  reason?: string | null,
  message?: string | null,
): string | undefined {
  const normalizedReason = String(reason ?? "").trim();
  const normalizedMessage = String(message ?? "").trim();

  if (normalizedReason && normalizedMessage) {
    return `${normalizedReason} — ${normalizedMessage}`;
  }

  return normalizedReason || normalizedMessage || undefined;
}
