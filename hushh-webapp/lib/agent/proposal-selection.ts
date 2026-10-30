/**
 * The ask card's selectable rows (C4, founder follow-up 2026-09-28).
 *
 * One proposes information by opaque reference; the person's catalog, already
 * loaded for the card, says how those references nest (`domain`,
 * `pathSegments`, `wildcard`). A proposed wildcard becomes a group row whose
 * children are the catalog entries it covers, so "Legal entity" opens to show
 * "Entity" and either can be chosen.
 *
 * A proposed item missing from that catalog is looked up by label on the
 * server (`proposalLookups`) before Send is offered, so a broad ask still
 * nests.
 *
 * Coverage comes only from `covers` in `lib/consent/request-scope-selection.ts`
 * and the sent set only from `selectedRequestScopes`, the same rules the
 * catalog review uses: a fully chosen group is sent as its one broad scope,
 * a partly chosen group as exactly the chosen children.
 */
import { humanSharedLabel } from "@/lib/agent/agui-structured-experiences";
import { covers, selectedRequestScopes } from "@/lib/consent/request-scope-selection";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";
import type { ScopeProposal } from "@/lib/agent/scope-proposal";

export type ProposalNode = { scope: RequestablePersonScope; children: RequestablePersonScope[] };
export type ProposalCheckState = "checked" | "mixed" | "unchecked";

const MAX_CHILDREN = 30;

/** Human label for a row: never a machine label, never "Domain". */
export function proposalRowLabel(scope: Pick<RequestablePersonScope, "label">): string {
  return humanSharedLabel(scope.label) ?? "Selected information";
}

/**
 * Proposed items the loaded catalog does not hold, by label.
 *
 * The card's catalog is the viewer's first page, ranked narrowest first, so a
 * broad item ("Food & dining information", `attr.food.*`) sorts last and is
 * never on it (measured 2026-09-29: 251 items, 100 a page). Without its place
 * in the catalog the card cannot nest anything under it, and a broad ask
 * rendered its parent and child side by side. A server search by the item's
 * own label returns it with its place, and the items it covers beside it.
 */
export function proposalLookups(proposal: ScopeProposal, catalog: readonly RequestablePersonScope[]): string[] {
  const known = new Set(catalog.map((scope) => scope.scopeRef));
  return [...new Set(proposal.proposed.filter((item) => !known.has(item.scopeRef)).map((item) => item.label))];
}

/** The loaded catalog plus what the lookups found, first seen wins. */
export function mergeProposalCatalog(
  catalog: readonly RequestablePersonScope[],
  found: readonly RequestablePersonScope[],
): RequestablePersonScope[] {
  const all = new Map<string, RequestablePersonScope>();
  for (const scope of [...catalog, ...found]) if (!all.has(scope.scopeRef)) all.set(scope.scopeRef, scope);
  return [...all.values()];
}

export function proposalTree(
  proposal: ScopeProposal,
  catalog: readonly RequestablePersonScope[],
): ProposalNode[] {
  const byRef = new Map(catalog.map((scope) => [scope.scopeRef, scope]));
  const proposed = proposal.proposed.map<RequestablePersonScope>((item) => {
    const known = byRef.get(item.scopeRef);
    if (known) return { ...known, label: known.label || item.label, pathSegments: known.pathSegments ?? item.pathSegments };
    // Not in the catalog: the proposal's own place, when the server sent one.
    return {
      scopeRef: item.scopeRef, label: item.label, description: null, domain: item.domain ?? null, sensitivity: null,
      wildcard: item.wildcard === true, ...(item.pathSegments ? { pathSegments: item.pathSegments } : {}),
    };
  });
  const nodes: ProposalNode[] = [];
  for (const scope of proposed) {
    // A proposed item under another proposed group is that group's child.
    if (proposed.some((other) => other !== scope && covers(other, scope))) continue;
    const children = scope.wildcard
      ? [...catalog, ...proposed].filter((entry, index, all) => entry.scopeRef !== scope.scopeRef
        && all.findIndex((other) => other.scopeRef === entry.scopeRef) === index && covers(scope, entry))
        .slice(0, MAX_CHILDREN)
      : [];
    nodes.push({ scope, children });
  }
  return nodes;
}

/** Everything the rows can select: groups, their children, and picker additions. */
export function proposalUniverse(nodes: readonly ProposalNode[], extras: readonly RequestablePersonScope[]): RequestablePersonScope[] {
  const all = new Map<string, RequestablePersonScope>();
  for (const node of nodes) {
    all.set(node.scope.scopeRef, node.scope);
    for (const child of node.children) all.set(child.scopeRef, child);
  }
  for (const extra of extras) if (!all.has(extra.scopeRef)) all.set(extra.scopeRef, extra);
  return [...all.values()];
}

/** Every proposed row starts chosen, a group with all of its children. */
export function initialProposalSelection(nodes: readonly ProposalNode[]): Set<string> {
  return new Set(nodes.flatMap((node) => [node.scope.scopeRef, ...node.children.map((child) => child.scopeRef)]));
}

export function proposalCheckState(node: ProposalNode, selected: ReadonlySet<string>): ProposalCheckState {
  if (!node.children.length) return selected.has(node.scope.scopeRef) ? "checked" : "unchecked";
  const chosen = node.children.filter((child) => selected.has(child.scopeRef)).length;
  if (selected.has(node.scope.scopeRef) || chosen === node.children.length) return "checked";
  return chosen ? "mixed" : "unchecked";
}

/**
 * Toggle one row. A group takes or drops its whole branch. Dropping a child
 * drops the group's broad scope (it would still include that child); taking
 * the last missing child restores it.
 */
export function toggleProposalRow(
  nodes: readonly ProposalNode[],
  selected: ReadonlySet<string>,
  scopeRef: string,
  select: boolean,
): Set<string> {
  const next = new Set(selected);
  const group = nodes.find((node) => node.scope.scopeRef === scopeRef && node.children.length);
  if (group) {
    for (const ref of [group.scope.scopeRef, ...group.children.map((child) => child.scopeRef)]) {
      if (select) next.add(ref);
      else next.delete(ref);
    }
    return next;
  }
  if (select) next.add(scopeRef);
  else next.delete(scopeRef);
  for (const node of nodes) {
    if (!node.children.some((child) => child.scopeRef === scopeRef)) continue;
    if (!select) next.delete(node.scope.scopeRef);
    else if (node.children.every((child) => next.has(child.scopeRef))) next.add(node.scope.scopeRef);
  }
  return next;
}

/** Exactly what Send submits. */
export function proposalSendScopes(
  universe: readonly RequestablePersonScope[],
  selected: ReadonlySet<string>,
): RequestablePersonScope[] {
  return selectedRequestScopes(universe, selected);
}

/** What the person sees as chosen: a group counts its chosen children. */
export function proposalChosenCount(
  nodes: readonly ProposalNode[],
  extras: readonly RequestablePersonScope[],
  selected: ReadonlySet<string>,
): number {
  const inTree = new Set(proposalUniverse(nodes, []).map((scope) => scope.scopeRef));
  const tree = nodes.reduce((sum, node) => {
    if (!node.children.length) return sum + (selected.has(node.scope.scopeRef) ? 1 : 0);
    return sum + (selected.has(node.scope.scopeRef)
      ? node.children.length
      : node.children.filter((child) => selected.has(child.scopeRef)).length);
  }, 0);
  return tree + extras.filter((extra) => !inTree.has(extra.scopeRef) && selected.has(extra.scopeRef)).length;
}

/** Labels for the ask sentence: a whole group by its name, else its chosen children. */
export function proposalChosenLabels(
  nodes: readonly ProposalNode[],
  extras: readonly RequestablePersonScope[],
  selected: ReadonlySet<string>,
): string[] {
  const inTree = new Set(proposalUniverse(nodes, []).map((scope) => scope.scopeRef));
  const labels = nodes.flatMap((node) => {
    const state = proposalCheckState(node, selected);
    if (state === "checked") return [proposalRowLabel(node.scope)];
    if (state === "mixed") return node.children.filter((child) => selected.has(child.scopeRef)).map(proposalRowLabel);
    return [];
  });
  return [...labels, ...extras.filter((extra) => !inTree.has(extra.scopeRef) && selected.has(extra.scopeRef)).map(proposalRowLabel)];
}
