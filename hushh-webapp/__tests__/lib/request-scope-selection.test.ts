import { describe, expect, it } from "vitest";

import { selectedRequestScopes, toggleRequestScopes } from "@/lib/consent/request-scope-selection";
import type { RequestablePersonScope } from "@/lib/services/person-profile-service";

const scope = (scopeRef: string, domain: string, pathSegments: string[] | undefined, wildcard = false): RequestablePersonScope => ({
  scopeRef, domain, pathSegments, wildcard, label: scopeRef, description: null, sensitivity: null,
});

const catalog = [
  scope("opaque-root", "professional", [], true),
  scope("opaque-work", "professional", ["work"], true),
  scope("opaque-role", "professional", ["work", "role"]),
  scope("opaque-team", "professional", ["work", "team"]),
  scope("opaque-profile", "professional", ["profile"]),
  scope("opaque-finance", "financial", ["income"]),
];

describe("request scope selection", () => {
  it("sends one eligible root request when the root and all its children were selected", () => {
    const selected = new Set(catalog.map((entry) => entry.scopeRef));
    expect(selectedRequestScopes(catalog, selected).map((entry) => entry.scopeRef))
      .toEqual(["opaque-root", "opaque-finance"]);
  });

  it("removes a broad scope when a child is deselected, preserving the other choices", () => {
    const selected = new Set(catalog.slice(0, 5).map((entry) => entry.scopeRef));
    const narrowed = toggleRequestScopes(catalog, selected, ["opaque-role"], false);
    expect([...narrowed].sort()).toEqual(["opaque-profile", "opaque-team"].sort());
    expect(selectedRequestScopes(catalog, narrowed).map((entry) => entry.scopeRef))
      .toEqual(["opaque-team", "opaque-profile"]);
  });

  it("does not infer coverage from opaque ids or missing hierarchy", () => {
    const unknown = scope("opaque-another", "professional", undefined);
    expect(selectedRequestScopes([...catalog, unknown], new Set(["opaque-root", unknown.scopeRef]))
      .map((entry) => entry.scopeRef)).toEqual(["opaque-root", unknown.scopeRef]);
  });

  it("does not cross domains or collapse an exact non-wildcard parent", () => {
    const exact = scope("opaque-exact", "professional", ["work"]);
    expect(selectedRequestScopes([exact, catalog[2]!, catalog[5]!], new Set([exact.scopeRef, catalog[2]!.scopeRef, catalog[5]!.scopeRef]))
      .map((entry) => entry.scopeRef)).toEqual([exact.scopeRef, catalog[2]!.scopeRef, catalog[5]!.scopeRef]);
  });
});
