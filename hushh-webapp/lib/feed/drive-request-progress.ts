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
  /** True while the request only waits in the queue: the row shows no working motion. */
  waiting?: boolean;
  /** When a waiting request entered the queue, so the row can show how long it waited. */
  queuedAt?: number | null;
}

type ProgressState = "queued" | "delayed" | "searching" | "sharing" | "checking";
const PROGRESS_STATES = new Set<unknown>(["queued", "delayed", "searching", "sharing", "checking"]);
const LEGACY_STAGE_STATES: Record<string, ProgressState> = {
  // An older server's "preparing" meant nothing had started yet.
  preparing: "queued", finding: "searching", sharing: "sharing", checking: "checking",
};

/** The server's truthful state, or the legacy stage it replaces on older servers. */
function progressState(metadata: Record<string, unknown>): ProgressState {
  const state = metadata.automatic_progress_state;
  if (PROGRESS_STATES.has(state)) return state as ProgressState;
  return LEGACY_STAGE_STATES[String(metadata.automatic_progress_stage)] ?? "queued";
}

function progressTitle(state: ProgressState): string {
  if (state === "searching") return "Finding documents";
  if (state === "checking") return "Checking documents";
  if (state === "sharing") return "Sharing documents";
  // Nothing runs yet; never claim work, and never "paused".
  return state === "delayed" ? "Taking longer than usual" : "Waiting to start";
}

/** An owner-allowed request runs the Trusted Circle pipeline; its copy must not claim Trusted Circle. */
function progressDescription(direction: "incoming" | "outgoing", ownerAllowed: boolean, state: ProgressState): string {
  if (state === "checking") return "One is checking the documents for this request.";
  if (state === "delayed") {
    return "Saved · continues automatically";
  }
  if (state === "queued") {
    return ownerAllowed
      ? "Request allowed. The Drive search starts soon."
      : "Trusted Circle request. The Drive search starts soon.";
  }
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

    const state = progressState(metadata);
    const waiting = automatic && !unavailable && (state === "queued" || state === "delayed");
    const queuedAt = waiting && typeof metadata.automatic_queued_at === "string"
      ? parseConsentInstant(metadata.automatic_queued_at) : null;
    byRequest.set(entry.id, {
      id: entry.id,
      title: unavailable ? "Documents unavailable" : automatic ? progressTitle(state) : "Document request sent",
      description: [
        quote,
        unavailable
          ? "Couldn't verify documents"
          : automatic
          ? progressDescription(direction, metadata.owner_allowed === true, state)
          : "Awaiting review",
      ].filter(Boolean).join(" · "),
      ...(waiting ? { waiting: true, queuedAt } : {}),
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
