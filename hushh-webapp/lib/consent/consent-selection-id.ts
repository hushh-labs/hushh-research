import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import {
  answerRequestSelection,
  isAnswerRequestEntry,
  isAnswerRequestSelection,
} from "@/lib/consent/answer-request-consent";
import { driveSharingSelectionId } from "@/lib/consent/drive-query-consent";

/**
 * The selection id a Consent Center row puts in the URL.
 *
 * A lane that owns its own review card has to keep its discriminated
 * `entry.id` there. Falling back to the bare `request_id` dropped the lane's
 * prefix, so the detail panel could only recognise the lane while the row
 * happened to be in the loaded list. On a reload of that link, a deep link, a
 * tab switch or the next page the row is absent, and a paid-answer request
 * fell through to the generic approve/deny path — which grants the scopes
 * without ever showing the question, the information it would use, or the
 * price.
 *
 * Recognition is per lane and explicit: a new request source gains a URL
 * discriminator only by being named here, next to the card that decides it.
 */
export function consentSelectionId(entry: ConsentCenterEntry): string {
  if (isAnswerRequestEntry(entry)) {
    return isAnswerRequestSelection(entry.id)
      ? entry.id
      : answerRequestSelection(entry.request_id ?? entry.id);
  }
  // Both Drive lanes already keep their own discriminated id.
  return driveSharingSelectionId(entry);
}
