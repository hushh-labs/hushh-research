"use client";

/**
 * One shape for "a thing someone can ask you for", wherever it is shown.
 *
 * Sixteen surfaces hand-rolled their own list of these, each with its own
 * grouping, its own search threshold, and its own idea of what a readable label
 * is. The profile listed them flat, the person page grouped them, chat printed
 * the raw domain key beside each row, and the Memory tab collapsed them into
 * bundles. Same information, four answers.
 *
 * The adapters below are deliberately thin: they rename fields and humanise a
 * domain, and nothing else. A label is AUTHORED upstream and is never
 * word-split or shortened here -- that was tried once and reverted, because
 * shortening "Employment status" to "status" names a different field.
 */

import { humanizeMemorySegment } from "@/lib/pkm/humanize-segment";
import type { PendingConsentLookupItem } from "@/lib/services/consent-center-service";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";
import type { PkmDomainPermissionPresentation } from "@/lib/profile/pkm-profile-presentation";

/**
 * Above this many rows a list gets a search field.
 *
 * Moved here from person-profile-page, which was the only surface that had
 * worked out a threshold at all. Six is where a list stops being scannable.
 */
export const SCOPE_SEARCH_THRESHOLD = 6;

/** Groups collapse by default past this, so a long list opens as an overview. */
export const SCOPE_COLLAPSE_THRESHOLD = 12;

export type ConsentScopeItem = {
  /** Selection key and React key. Stable across renders. */
  id: string;
  /** Authored upstream. Never split, never shortened. */
  label: string;
  description?: string | null;
  /** Raw grouping key, never shown to a person. */
  domainKey: string;
  /** The heading a person reads. Humanised once, here. */
  domainLabel: string;
  badge?: string | null;
  disabled?: boolean;
  /** Precomputed lowercase haystack, so filtering never rebuilds strings. */
  searchText: string;
};

function haystack(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** "saved_places" -> "Saved places". The one place a domain key becomes words. */
export function domainLabelFor(domainKey: string | null | undefined): string {
  const key = String(domainKey || "").trim();
  if (!key) return "Other";
  return humanizeMemorySegment(key);
}

/**
 * `attr.<domain>.<path>` split into its two useful halves.
 *
 * Exported so an adapter never has to re-derive the domain with its own regex,
 * which is how the thirteenth humanizer would have been born.
 */
export function parseConsentScope(scope: string | null | undefined): {
  domain: string;
  path: string;
} {
  const normalized = String(scope || "").trim();
  const match = normalized.match(/^attr\.([a-zA-Z0-9_]+)(?:\.(.*))?$/);
  if (match?.[1]) return { domain: match[1], path: String(match[2] || "").trim() };
  return { domain: "", path: normalized };
}

/** A person's own sharing controls, one domain's top-level paths. */
export function scopeItemsFromPermissions(
  permissions: readonly PkmDomainPermissionPresentation[],
): ConsentScopeItem[] {
  return permissions.map((permission) => ({
    id: permission.key,
    label: permission.label,
    description: permission.description,
    domainKey: permission.domainKey || "",
    domainLabel: permission.domainTitle || domainLabelFor(permission.domainKey),
    badge: permission.stateLabel || null,
    disabled: Boolean(permission.disabledReason),
    searchText: haystack([permission.label, permission.description, permission.domainTitle]),
  }));
}

/** What another person can be asked to share. */
export function scopeItemsFromRequestable(
  scopes: readonly RequestablePersonScope[],
): ConsentScopeItem[] {
  return scopes.map((scope) => {
    const domainKey = scope.domain || parseConsentScope(scope.scopeRef).domain || "other";
    return {
      id: scope.scopeRef,
      label: scope.label || scope.scopeRef,
      description: scope.description,
      domainKey,
      domainLabel: domainLabelFor(domainKey),
      badge: sensitivityBadge(scope.sensitivity),
      searchText: haystack([scope.label, scope.description, domainKey]),
    };
  });
}

/** One pending request waiting on the owner's decision, as shown in chat. */
export function scopeItemFromPendingConsent(
  item: PendingConsentLookupItem,
): ConsentScopeItem | null {
  const id = String(item.request_id || "").trim();
  if (!id) return null;
  const domainKey = parseConsentScope(item.scope).domain || "other";
  const label = item.scope_description || item.scope || "Something about you";
  return {
    id,
    label,
    description: item.reason ?? null,
    domainKey,
    domainLabel: domainLabelFor(domainKey),
    badge: null,
    searchText: haystack([label, item.reason, domainKey]),
  };
}

/** Only the tiers worth interrupting someone for. Standard needs no badge. */
export function sensitivityBadge(sensitivity: string | null | undefined): string | null {
  const value = String(sensitivity || "").trim().toLowerCase();
  if (value === "restricted") return "Highly sensitive";
  if (value === "sensitive" || value === "confidential") return "Sensitive";
  return null;
}

export type ScopeGroup = { domainKey: string; domainLabel: string; items: ConsentScopeItem[] };

/** Group by domain, preserving first-seen order so the list never reshuffles. */
export function groupScopeItems(items: readonly ConsentScopeItem[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const item of items) {
    const existing = groups.get(item.domainKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(item.domainKey, {
      domainKey: item.domainKey,
      domainLabel: item.domainLabel,
      items: [item],
    });
  }
  return [...groups.values()];
}

export function filterScopeItems(
  items: readonly ConsentScopeItem[],
  query: string,
): ConsentScopeItem[] {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => item.searchText.includes(needle));
}

/**
 * Fold one more pending request into a card that already represents its bundle.
 *
 * The backend writes one consent event PER SCOPE -- correctly, because a grant
 * and a revocation are per-scope security decisions. But a person asked for
 * fourteen things once, and answering fourteen separate cards is not the same
 * question. Only the decision surface bundles; the authority underneath does
 * not change.
 *
 * Order-independent and idempotent: requests arrive over a live channel, and
 * the same id can be delivered twice.
 */
export function mergeScopeItems(
  existing: readonly ConsentScopeItem[],
  incoming: readonly ConsentScopeItem[],
): ConsentScopeItem[] {
  const byId = new Map<string, ConsentScopeItem>();
  for (const item of [...existing, ...incoming]) byId.set(item.id, item);
  return [...byId.values()];
}
