"use client";

/**
 * What an Allow would actually hand over, counted on the owner's own device.
 *
 * The preview is built by the SAME export builder the approve path uses, from
 * the owner's encrypted memory decrypted locally with their vault key, and it is
 * summarised here into human labels and counts. Nothing about it leaves the
 * device: no plaintext, no counts, no labels are sent anywhere. Showing labels
 * and counts (not values) keeps the sheet calm while still answering the one
 * question an owner has before tapping Allow: "what exactly will they see?"
 */

import { useEffect, useState } from "react";

import {
  buildConsentExportForScope,
  ConsentExportNoDataError,
} from "@/lib/consent/export-builder";
import { toSentenceCase } from "@/lib/consent/consent-owner-copy";

export type ConsentSharePreviewGroup = {
  label: string;
  count: number;
  /**
   * Names of the things inside, read on this device from the owner's own
   * memory keys ("Favorite restaurants"). Names only, never values, and never
   * a word the label already says ("Preferences" under "Food preferences").
   */
  names?: string[];
};

export type ConsentSharePreview = {
  total: number;
  groups: ConsentSharePreviewGroup[];
};

const EXPORT_METADATA_KEY = "__export_metadata";
const COLLECTION_KEY = /^_?(?:entities|items)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isShareable(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(isShareable);
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([key, item]) => key !== EXPORT_METADATA_KEY && isShareable(item),
    );
  }
  return false;
}

/** How many things a value holds: list entries, collection members, or 1. */
function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.filter(isShareable).length;
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (COLLECTION_KEY.test(key)) return collectionSize(child);
    }
    return isShareable(value) ? 1 : 0;
  }
  return isShareable(value) ? 1 : 0;
}

function collectionSize(value: unknown): number {
  if (Array.isArray(value)) return value.filter(isShareable).length;
  if (isPlainObject(value)) {
    return Object.values(value).filter(isShareable).length;
  }
  return 0;
}

function humanKey(key: string): string {
  const words = key.replace(/^_+/, "").replace(/[_.-]+/g, " ").trim();
  return words ? toSentenceCase(words) : "Details";
}

function addGroup(
  groups: Map<string, number>,
  label: string,
  count: number,
) {
  if (count <= 0) return;
  groups.set(label, (groups.get(label) ?? 0) + count);
}

function walk(
  node: unknown,
  trailLabel: string,
  groups: Map<string, number>,
) {
  let current = node;
  let label = trailLabel;
  // Unwrap single-key wrappers ({ food: { preferences: {...} } }) so the
  // groups are the things a person recognises, not our nesting.
  while (isPlainObject(current)) {
    const wrapper: Record<string, unknown> = current;
    const keys = Object.keys(wrapper).filter((key) => isShareable(wrapper[key]));
    if (keys.length !== 1) break;
    const only = keys[0]!;
    if (COLLECTION_KEY.test(only)) {
      addGroup(groups, label, collectionSize(wrapper[only]));
      return;
    }
    label = humanKey(only);
    current = wrapper[only];
  }
  if (!isPlainObject(current)) {
    addGroup(groups, label, countOf(current));
    return;
  }
  for (const [key, child] of Object.entries(current)) {
    if (!isShareable(child)) continue;
    if (COLLECTION_KEY.test(key)) {
      addGroup(groups, label, collectionSize(child));
      continue;
    }
    addGroup(groups, humanKey(key), countOf(child));
  }
}

/** Summarise one export payload into human labels and counts. */
export function summarizeConsentExportPayload(
  payload: Record<string, unknown>,
  fallbackLabel = "Details",
): ConsentSharePreview {
  const groups = new Map<string, number>();
  for (const [key, value] of Object.entries(payload)) {
    if (key === EXPORT_METADATA_KEY || !isShareable(value)) continue;
    walk(value, fallbackLabel, groups);
  }
  const list = [...groups.entries()].map(([label, count]) => ({
    label,
    count,
  }));
  return {
    total: list.reduce((sum, group) => sum + group.count, 0),
    groups: list,
  };
}

/** Merge several per-item previews into one, keeping label order. */
export function mergeConsentSharePreviews(
  previews: ConsentSharePreview[],
): ConsentSharePreview {
  const groups = new Map<string, number>();
  const names = new Map<string, string[]>();
  for (const preview of previews) {
    for (const group of preview.groups) {
      addGroup(groups, group.label, group.count);
      if (group.names?.length) {
        names.set(group.label, [...new Set([...(names.get(group.label) ?? []), ...group.names])]);
      }
    }
  }
  const list = [...groups.entries()].map(([label, count]) => ({
    label,
    count,
    ...(names.get(label)?.length ? { names: names.get(label) } : {}),
  }));
  return {
    total: list.reduce((sum, group) => sum + group.count, 0),
    groups: list,
  };
}

/**
 * One requested item as the owner reads it: the request's own human label
 * (the server's, e.g. "Food preferences"), its count, and the names inside
 * it. Headings never come from this device's key walk, which named the same
 * item "Preferences".
 */
export function requestedItemPreview(
  itemLabel: string,
  summary: ConsentSharePreview,
): ConsentSharePreview {
  const label = itemLabel.trim() || "Details";
  const lowered = label.toLowerCase();
  const names = summary.groups
    .map((group) => group.label)
    .filter((name) => name !== "Details" && !lowered.includes(name.toLowerCase()));
  if (summary.total <= 0) return { total: 0, groups: [] };
  return {
    total: summary.total,
    groups: [{ label, count: summary.total, ...(names.length ? { names } : {}) }],
  };
}

export type ConsentSharePreviewState =
  | { status: "idle" }
  | { status: "locked" }
  /** Counting on this device; the requested labels show meanwhile. */
  | { status: "loading"; labels: string[] }
  | { status: "ready"; preview: ConsentSharePreview }
  | { status: "empty" }
  | { status: "unavailable" };

export type ConsentSharePreviewItem = { scope: string; label: string };

function isPreviewableScope(scope: string): boolean {
  return scope === "pkm.read" || scope.startsWith("attr.");
}

/**
 * Build the preview for the items an Allow would share.
 *
 * Only memory-backed items can be previewed; anything else reports
 * `unavailable` and the sheet simply omits the section rather than guessing.
 */
export function useConsentSharePreview(input: {
  userId: string | null | undefined;
  vaultKey: string | null | undefined;
  getVaultOwnerToken: () => string | null | undefined;
  items: ConsentSharePreviewItem[];
  enabled: boolean;
}): ConsentSharePreviewState {
  const { userId, vaultKey, getVaultOwnerToken, items, enabled } = input;
  const itemsKey = items.map((item) => `${item.scope}\u0000${item.label}`).join("\u0001");
  const [state, setState] = useState<ConsentSharePreviewState>({
    status: "idle",
  });

  useEffect(() => {
    if (!enabled || items.length === 0) {
      setState({ status: "idle" });
      return;
    }
    if (!items.every((item) => isPreviewableScope(item.scope))) {
      setState({ status: "unavailable" });
      return;
    }
    const vaultOwnerToken = getVaultOwnerToken();
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setState({ status: "locked" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", labels: [...new Set(items.map((item) => item.label))] });
    void (async () => {
      const previews: ConsentSharePreview[] = [];
      let unavailable = false;
      for (const item of items) {
        try {
          const built = await buildConsentExportForScope({
            userId,
            scope: item.scope,
            vaultKey,
            vaultOwnerToken,
          });
          previews.push(requestedItemPreview(item.label, summarizeConsentExportPayload(built.payload, item.label)));
        } catch (error) {
          if (!(error instanceof ConsentExportNoDataError)) unavailable = true;
        }
        if (cancelled) return;
      }
      if (cancelled) return;
      const merged = mergeConsentSharePreviews(previews);
      if (merged.total > 0) setState({ status: "ready", preview: merged });
      else setState({ status: unavailable ? "unavailable" : "empty" });
    })();
    return () => {
      cancelled = true;
    };
    // `items` is keyed by content so a re-render with an equal list does not
    // rebuild the export.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, itemsKey, userId, vaultKey, getVaultOwnerToken]);

  return state;
}
