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

function progressTitle(stage: unknown): string {
  if (stage === "finding") return "One is finding documents";
  if (stage === "sharing") return "One is sharing documents";
  return "One is preparing the document request";
}

/** Only the server's active Trusted Circle projection can create a passive row. */
export function projectFeedDriveProgress(
  entries: ConsentCenterEntry[],
): FeedDriveProgress[] {
  const byRequest = new Map<string, FeedDriveProgress>();
  for (const entry of entries) {
    if (!isDocumentShareEntry(entry)) continue;
    if (!documentShareRequestId(entry.id)) continue;
    if (entry.metadata?.automatic_progress_active !== true) continue;
    const direction = entry.metadata.direction;
    if (direction !== "incoming" && direction !== "outgoing") continue;
    const pending = entry.status === "pending" &&
      entry.kind === (direction === "incoming" ? "incoming_request" : "outgoing_request");
    const active = entry.status === "active" && entry.kind === "active_grant";
    if (!pending && !active) continue;

    byRequest.set(entry.id, {
      id: entry.id,
      title: progressTitle(entry.metadata.automatic_progress_stage),
      description:
        direction === "incoming"
          ? "One is handling a Trusted Circle request for you. Sharing is automatic."
          : "One is handling your Trusted Circle request. Files appear after access is confirmed.",
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
