import type { FeedItem } from "@/lib/services/feed-service";

const DRIVE_EVENT_DOMAIN = "connected_systems";
const DRIVE_DECISION_EVENT = "document_share_decided";
const DRIVE_OUTCOME_EVENT = "document_share_outcome";

/**
 * The Drive worker publishes progress and then a terminal outcome. Older
 * rows can arrive together when a live Feed refresh races a queued worker, so
 * rendering every immutable row can tell both "files are available" and "no
 * matching files" for one request. Remove only the contradicted state while
 * preserving valid progress, payment, and request rows.
 */
const SUCCESSFUL_STATUSES = new Set(["partial", "completed"]);
const EMPTY_STATUSES = new Set(["no_match", "no_files_shared"]);

function requestId(item: FeedItem): string {
  const value = item.metadata?.request_id;
  return typeof value === "string" ? value.trim() : "";
}

function isDriveLifecycleItem(item: FeedItem): boolean {
  return (
    item.source_domain === DRIVE_EVENT_DOMAIN &&
    (item.event_type === DRIVE_DECISION_EVENT ||
      item.event_type === DRIVE_OUTCOME_EVENT)
  );
}

function status(item: FeedItem): string {
  const value = item.metadata?.user_facing_status;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Collapse contradictory Drive lifecycle rows for the same request.
 *
 * Feed rows stay append-only for auditability. This is a presentation fold:
 * payment rows and request rows remain visible, while a terminal outcome
 * supersedes only the contradictory state: a successful outcome removes stale
 * empty outcomes, while an empty outcome removes an availability decision.
 * Other valid progress rows remain visible in the Feed history.
 */
export function collapseDriveLifecycleRows(items: FeedItem[]): FeedItem[] {
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (!isDriveLifecycleItem(item)) continue;
    const id = requestId(item);
    if (!id) continue;
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }

  const successfulOutcomeIds = new Set<string>();
  const emptyOutcomeIds = new Set<string>();
  for (const [id, group] of groups) {
    for (const item of group) {
      if (item.event_type !== DRIVE_OUTCOME_EVENT) continue;
      if (SUCCESSFUL_STATUSES.has(status(item))) successfulOutcomeIds.add(id);
      if (EMPTY_STATUSES.has(status(item))) emptyOutcomeIds.add(id);
    }
  }

  const result: FeedItem[] = [];
  for (const item of items) {
    if (!isDriveLifecycleItem(item)) {
      result.push(item);
      continue;
    }
    const id = requestId(item);
    if (!id) {
      result.push(item);
      continue;
    }
    const hasSuccessfulOutcome = successfulOutcomeIds.has(id);
    const hasEmptyOutcome = emptyOutcomeIds.has(id);
    if (
      item.event_type === DRIVE_OUTCOME_EVENT &&
      EMPTY_STATUSES.has(status(item)) &&
      hasSuccessfulOutcome
    ) {
      // A successful terminal state proves that the no-match row is stale.
      continue;
    }
    if (
      item.event_type === DRIVE_DECISION_EVENT &&
      hasEmptyOutcome &&
      !hasSuccessfulOutcome
    ) {
      // No files means an availability notice cannot be actionable anymore.
      continue;
    }
    result.push(item);
  }
  return result;
}
