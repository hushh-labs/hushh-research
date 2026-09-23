import type { RequestablePersonScope } from "@/lib/services/person-profile-service";

/** Scope references are opaque. Coverage comes only from server-supplied hierarchy. */
function covers(parent: RequestablePersonScope, child: RequestablePersonScope): boolean {
  if (!parent.wildcard || parent.scopeRef === child.scopeRef || !parent.domain || parent.domain !== child.domain) return false;
  if (!Array.isArray(parent.pathSegments) || !Array.isArray(child.pathSegments)) return false;
  return parent.pathSegments.length <= child.pathSegments.length
    && parent.pathSegments.every((part, index) => part === child.pathSegments![index]);
}

/** Never send a broad request and its covered children as separate requests. */
export function selectedRequestScopes(
  catalog: readonly RequestablePersonScope[],
  selectedRefs: ReadonlySet<string>,
): RequestablePersonScope[] {
  const selected = catalog.filter((scope) => selectedRefs.has(scope.scopeRef));
  return selected.filter((scope) => !selected.some((parent) => covers(parent, scope)));
}

/** Removing one child also removes a selected wildcard that would still include it. */
export function toggleRequestScopes(
  catalog: readonly RequestablePersonScope[],
  current: ReadonlySet<string>,
  refs: readonly string[],
  select: boolean,
): Set<string> {
  const next = new Set(current);
  const changed = new Set(refs);
  for (const ref of changed) {
    if (select) next.add(ref);
    else next.delete(ref);
  }
  if (!select) {
    const removed = catalog.filter((scope) => changed.has(scope.scopeRef));
    for (const parent of catalog) {
      if (next.has(parent.scopeRef) && removed.some((child) => covers(parent, child))) {
        next.delete(parent.scopeRef);
      }
    }
  }
  return next;
}
