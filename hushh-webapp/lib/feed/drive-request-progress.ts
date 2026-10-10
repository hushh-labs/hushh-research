import { isDocumentShareEntry, documentShareRequestId } from "@/lib/consent/document-share-consent";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import { formatDocumentRequestPrice, isValidDocumentRequestPriceCents } from "@/lib/consent/document-request-price";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

export interface FeedDriveProgress {
  id: string;
  title: string;
  description: string;
  href: string;
  requestedAt: number | null;
}

function progressTitle(stage: unknown): string {
  if (stage === "finding") return "One is finding documents";
  if (stage === "sharing") return "One is sharing documents";
  return "One is preparing the document request";
}

/** An owner-allowed request runs the Trusted Circle pipeline; its copy must not claim Trusted Circle. */
function progressDescription(direction: "incoming" | "outgoing", ownerAllowed: boolean): string {
  if (ownerAllowed) {
    return direction === "incoming"
      ? "Request allowed. One is handling it for you. Sharing is automatic."
      : "Request allowed. One is handling it. Files appear after access is confirmed.";
  }
  return direction === "incoming"
    ? "One is handling a Trusted Circle request for you. Sharing is automatic."
    : "One is handling your Trusted Circle request. Files appear after access is confirmed.";
}

/** Only the server's active automatic projection (Trusted Circle or owner-allowed) can create a passive row. */
export function projectFeedDriveProgress(
  entries: ConsentCenterEntry[],
): FeedDriveProgress[] {
  const byRequest = new Map<string, FeedDriveProgress>();
  for (const entry of entries) {
    if (!isDocumentShareEntry(entry)) continue;
    if (!documentShareRequestId(entry.id)) continue;
    const metadata = entry.metadata || {};
    const direction = metadata.direction;
    if (direction !== "incoming" && direction !== "outgoing") continue;
    const quote = direction === "outgoing" && metadata.paymentRequired === true &&
      isValidDocumentRequestPriceCents(metadata.quotedAmountCents)
      ? formatDocumentRequestPrice(metadata.quotedAmountCents)
      : null;
    const automatic = metadata.automatic_progress_active === true;
    if (!automatic && !quote) continue;
    // Checkout must never be described as if sharing is already running.
    if (metadata.paymentStatus === "awaiting_payment" || metadata.paymentStatus === "checkout_open") continue;
    if (metadata.paymentStatus === "expired" || metadata.ownerPayoutAccountReady === false) continue;
    if (metadata.paymentReconciliationRequired === true) continue;
    const pending = entry.status === "pending" &&
      entry.kind === (direction === "incoming" ? "incoming_request" : "outgoing_request");
    const active = entry.status === "active" && entry.kind === "active_grant";
    if (!pending && !active) continue;
    if (!automatic && !pending) continue;

    byRequest.set(entry.id, {
      id: entry.id,
      title: automatic ? progressTitle(metadata.automatic_progress_stage) : "Document request sent",
      description: [
        quote ? `Quote locked at ${quote}` : null,
        automatic
          ? progressDescription(direction, metadata.owner_allowed === true)
          : "Waiting for the owner to review your request.",
      ].filter(Boolean).join(" · "),
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
