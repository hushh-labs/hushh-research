import type { PkmMemoryCard, PkmPathSegment } from "@/lib/pkm/pkm-memory-cards";
import type { DomainManifest, PkmScopeRegistryEntry } from "@/lib/personal-knowledge-model/manifest";
import { isPrivatePkmExportScope } from "@/lib/consent/pkm-scope-policy";

export type PkmMemoryTreeNode = {
  id: string;
  label: string;
  path: PkmPathSegment[];
  children: PkmMemoryTreeNode[];
  card: PkmMemoryCard | null;
};

export type PkmShareBundle = {
  scopeHandle: string | null;
  topLevelScopePath: string;
  label: string;
  enabled: boolean;
};

function nodeId(path: readonly PkmPathSegment[]): string {
  return path.map(String).join(".");
}

function labelForSegment(segment: PkmPathSegment): string {
  if (typeof segment === "number") return `Item ${segment + 1}`;
  const normalized = segment.trim().toLowerCase();
  if (normalized === "entities" || normalized === "_items") return "Saved items";
  if (/^(mem|item|entry)_[a-z0-9_-]+$/i.test(segment)) return "Saved item";
  return segment
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function buildPkmMemoryTree(cards: readonly PkmMemoryCard[]): PkmMemoryTreeNode[] {
  const roots: PkmMemoryTreeNode[] = [];
  for (const card of cards) {
    let siblings = roots;
    let path: PkmPathSegment[] = [];
    for (let index = 0; index < card.pathSegments.length; index += 1) {
      const segment = card.pathSegments[index];
      if (segment === undefined) continue;
      path = [...path, segment];
      const id = nodeId(path);
      let node = siblings.find((candidate) => candidate.id === id);
      if (!node) {
        node = { id, label: labelForSegment(segment), path, children: [], card: null };
        siblings.push(node);
      }
      if (index === card.pathSegments.length - 1) node.card = card;
      siblings = node.children;
    }
  }
  const sortNodes = (nodes: PkmMemoryTreeNode[]) => {
    nodes.sort((left, right) => left.label.localeCompare(right.label));
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

function isMaterializedBundle(entry: PkmScopeRegistryEntry): boolean {
  const summary = entry.summary_projection || {};
  return (
    summary.consumer_visible !== false &&
    summary.internal_only !== true &&
    summary.materialization_state === "materialized" &&
    Number(summary.materialized_leaf_count || 0) > 0
  );
}

export function buildPkmShareBundles(manifest: DomainManifest | null): PkmShareBundle[] {
  if (!manifest) return [];
  return (manifest.scope_registry || [])
    .filter(isMaterializedBundle)
    .map((entry) => ({
      scopeHandle: entry.scope_handle || null,
      topLevelScopePath: String(entry.summary_projection?.top_level_scope_path || "").trim(),
      label: entry.scope_label || String(entry.summary_projection?.top_level_scope_path || "Saved details"),
      enabled: entry.visibility_posture !== "private" && entry.exposure_enabled !== false,
    }))
    .filter(
      (entry) =>
        Boolean(entry.topLevelScopePath) &&
        !isPrivatePkmExportScope(`attr.${manifest.domain}.${entry.topLevelScopePath}.*`)
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function pkmShareBundleState(bundles: readonly PkmShareBundle[]): "checked" | "unchecked" | "indeterminate" {
  if (!bundles.length || bundles.every((bundle) => !bundle.enabled)) return "unchecked";
  if (bundles.every((bundle) => bundle.enabled)) return "checked";
  return "indeterminate";
}
