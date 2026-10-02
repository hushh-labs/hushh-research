import { isDocumentShareEntry, documentShareRequestId } from "@/lib/consent/document-share-consent";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export interface FeedDriveProgress {
  id: string;
  title: string;
  description: string;
  href: string;
  requestedAt: number | null;
}

/**
 * The "In progress" label, One's icon and the live dot already say One is on
 * it, so the row names only the step and whose files move. A received request
 * always says sharing is automatic: that is the person's consent context.
 */
function progressTitle(stage: unknown, direction: "incoming" | "outgoing"): string {
  if (direction === "incoming") {
    if (stage === "finding") return "Finding your documents";
    if (stage === "sharing") return "Sharing your documents";
    return "Preparing your documents";
  }
  if (stage === "finding") return "Finding documents";
  if (stage === "sharing") return "Sharing documents with you";
  return "Preparing your request";
}

const PROGRESS_DESCRIPTION = {
  incoming: "Trusted Circle request. Sharing is automatic.",
  outgoing: "Files appear once access is confirmed.",
} as const;

/** Only the server's active Trusted Circle projection can create a passive row. */
export function projectFeedDriveProgress(
  entries: ConsentCenterEntry[],
): FeedDriveProgress[] {
  const byRequest = new Map<string, FeedDriveProgress>();
  for (const entry of entries) {
    if (!isDocumentShareEntry(entry)) continue;
    if (!documentShareRequestId(entry.id)) continue;
    if (entry.metadata?.automatic_progress_active !== true) continue;
    // Checkout must never be described as if sharing is already running.
    if (entry.metadata.paymentStatus === "awaiting_payment" || entry.metadata.paymentStatus === "checkout_open") continue;
    if (entry.metadata.paymentReconciliationRequired === true) continue;
    const direction = entry.metadata.direction;
    if (direction !== "incoming" && direction !== "outgoing") continue;
    const pending = entry.status === "pending" &&
      entry.kind === (direction === "incoming" ? "incoming_request" : "outgoing_request");
    const active = entry.status === "active" && entry.kind === "active_grant";
    if (!pending && !active) continue;

    byRequest.set(entry.id, {
      id: entry.id,
      title: progressTitle(entry.metadata.automatic_progress_stage, direction),
      description: PROGRESS_DESCRIPTION[direction],
      href: buildConsentCenterHref(active ? "active" : "pending", {
        requestId: entry.id,
        requestView: pending && direction === "outgoing" ? "sent" : "received",
        from: "/one/feed",
      }),
      requestedAt: parseConsentInstant(entry.issued_at),
    });
  }
  return [...byRequest.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
}
