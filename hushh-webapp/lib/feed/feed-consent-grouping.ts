import type { FeedItem } from "@/lib/services/feed-service";

const GROUPABLE_CONSENT_EVENTS = new Set([
  "consent_requested",
  "consent_granted",
  "consent_revoked",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => text(entry)).filter(Boolean)
    : [];
}

function bundleKey(item: FeedItem): string | null {
  if (item.source_domain !== "consent") return null;
  if (!GROUPABLE_CONSENT_EVENTS.has(item.event_type)) return null;
  const bundleId = text(item.metadata?.bundle_id);
  return bundleId ? `${item.event_type}:${bundleId}` : null;
}

function scopesOf(item: FeedItem): string[] {
  const metadata = item.metadata || {};
  const listed = stringList(metadata.grouped_scopes);
  if (listed.length) return listed;
  const scopes = stringList(metadata.scopes);
  if (scopes.length) return scopes;
  const scope = text(metadata.scope);
  return scope ? [scope] : [];
}

function labelsOf(item: FeedItem): string[] {
  const metadata = item.metadata || {};
  const listed = stringList(metadata.grouped_labels);
  if (listed.length) return listed;
  const labels = stringList(metadata.labels);
  if (labels.length) return labels;
  const label = text(metadata.scope_description);
  return label ? [label] : [];
}

/**
 * Fold per-item consent history rows that belong to one request into one row.
 *
 * The consent log writes a Feed row per item, so a three-item request read as
 * three "Consent requested" rows. Rows that share an event and a `bundle_id`
 * become the newest of them, carrying every item's key in `grouped_scopes`
 * (and any stored names in `grouped_labels`) for the renderer. Rows without a
 * `bundle_id` are untouched, and a row that stands alone keeps its identity so
 * the memoised Feed row does not re-render.
 *
 * The first occurrence keeps its position; the Feed is already newest first.
 */
export function collapseConsentBundleRows(items: FeedItem[]): FeedItem[] {
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    const key = bundleKey(item);
    if (!key) continue;
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }

  const emitted = new Set<string>();
  const result: FeedItem[] = [];
  for (const item of items) {
    const key = bundleKey(item);
    if (!key) {
      result.push(item);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const members = groups.get(key)!;
    if (members.length === 1) {
      result.push(item);
      continue;
    }
    result.push({
      ...item,
      read: members.every((member) => member.read),
      metadata: {
        ...item.metadata,
        grouped_scopes: Array.from(new Set(members.flatMap(scopesOf))),
        grouped_labels: Array.from(new Set(members.flatMap(labelsOf))),
        grouped_count: members.length,
      },
    });
  }
  return result;
}
