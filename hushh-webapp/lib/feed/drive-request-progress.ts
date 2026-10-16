import { documentRequestEntrySetup, documentRequestSetupLabel } from "@/lib/consent/document-request-setup";
import { isDocumentShareEntry, documentShareRequestId } from "@/lib/consent/document-share-consent";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import {
  priceViewFromEntryMetadata,
  requesterPriceLine,
} from "@/lib/consent/document-request-requester-view";
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
  if (stage === "checking") return "One is checking documents";
  if (stage === "sharing") return "One is sharing documents";
  return "One is preparing the document request";
}

/** An owner-allowed request runs the Trusted Circle pipeline; its copy must not claim Trusted Circle. */
function progressDescription(direction: "incoming" | "outgoing", ownerAllowed: boolean, stage: unknown): string {
  if (stage === "checking") return "One is checking the documents for this request.";
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
    const setup = documentRequestEntrySetup(entry);
    if (setup && direction === "outgoing") {
      // An existing priced Checkout owns its own waiting row. Before an order
      // exists this request still needs a durable, passive Feed milestone.
      if (setup === "payouts" && ["awaiting_payment", "checkout_open"].includes(String(metadata.paymentStatus))) continue;
      const owner = entry.counterpart_label?.trim();
      byRequest.set(entry.id, {
        id: entry.id,
        title: documentRequestSetupLabel(setup, false),
        description: owner && owner !== "Document request" ? `Documents from ${owner}` : "Document request pending",
        href: buildConsentCenterHref("pending", { requestId: entry.id, requestView: "sent", from: "/one/feed" }),
        requestedAt: parseConsentInstant(entry.issued_at),
      });
      continue;
    }
    if (setup) continue;
    // "Estimate $10", "Price $25 · estimate was $10" or "Final price $25":
    // the owner may set the price until an order freezes it.
    const priceView = direction === "outgoing" ? priceViewFromEntryMetadata(metadata) : null;
    const quote = priceView ? requesterPriceLine(priceView) : null;
    const automatic = metadata.automatic_progress_active === true;
    const unavailable = metadata.v1_evaluation_unavailable === true;
    if (!automatic && !quote && !unavailable) continue;
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
      title: unavailable ? "Documents unavailable" : automatic ? progressTitle(metadata.automatic_progress_stage) : "Document request sent",
      description: [
        quote,
        unavailable
          ? "One couldn't verify the documents for this request."
          : automatic
          ? progressDescription(direction, metadata.owner_allowed === true, metadata.automatic_progress_stage)
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
