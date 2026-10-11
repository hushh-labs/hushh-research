import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/**
 * Recognising a paid-answer request inside the Consent Center.
 *
 * Mirrors `drive-query-consent.ts`: recognition is deliberately broader than
 * parsing, so a malformed row fails closed into its own card instead of
 * reaching the generic approve/deny path — which would grant a scope set
 * without the question, the price or the payment ever being shown.
 */

export const ANSWER_REQUEST_SOURCE = "answer_request";
export const ANSWER_REQUEST_ACTION = "ANSWER_REQUEST_REVIEW";
const PREFIX = "answer_request:";

const REQUEST_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function answerRequestSelection(requestId: string): string {
  return `${PREFIX}${requestId}`;
}

export function isAnswerRequestEntry(
  entry: Pick<ConsentCenterEntry, "id" | "action" | "metadata">,
): boolean {
  return (
    entry.metadata?.request_source === ANSWER_REQUEST_SOURCE ||
    entry.action === ANSWER_REQUEST_ACTION ||
    entry.id.startsWith(PREFIX)
  );
}

export function isAnswerRequestSelection(
  selected: string | null | undefined,
): boolean {
  return !!selected?.startsWith(PREFIX);
}

export function answerRequestId(
  selected: string | null | undefined,
): string | null {
  if (!selected?.startsWith(PREFIX)) return null;
  const id = selected.slice(PREFIX.length);
  return REQUEST_UUID.test(id) ? id.toLowerCase() : null;
}
