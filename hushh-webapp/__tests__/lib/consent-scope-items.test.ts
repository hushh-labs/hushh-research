import { describe, expect, it } from "vitest";

import {
  SCOPE_SEARCH_THRESHOLD,
  domainLabelFor,
  filterScopeItems,
  groupScopeItems,
  mergeScopeItems,
  parseConsentScope,
  scopeItemFromPendingConsent,
  scopeItemsFromPermissions,
  scopeItemsFromRequestable,
  sensitivityBadge,
} from "@/lib/consent/consent-scope-items";

describe("parseConsentScope", () => {
  it("splits attr.<domain>.<path> into its two useful halves", () => {
    expect(parseConsentScope("attr.saved_places.locations.home")).toEqual({
      domain: "saved_places",
      path: "locations.home",
    });
    expect(parseConsentScope("attr.financial.*")).toEqual({ domain: "financial", path: "*" });
  });

  it("returns an empty domain rather than guessing for a non-attr scope", () => {
    expect(parseConsentScope("vault.owner")).toEqual({ domain: "", path: "vault.owner" });
    expect(parseConsentScope(null)).toEqual({ domain: "", path: "" });
  });
});

describe("domainLabelFor", () => {
  it("turns a raw domain key into words once, here", () => {
    expect(domainLabelFor("saved_places")).toBe("Saved Places");
    expect(domainLabelFor("")).toBe("Other");
  });
});

describe("adapters", () => {
  it("carries the domain from a permission instead of parsing it back out of the key", () => {
    // The domain used to live only inside `key` as `${domain}:${path}`, so every
    // consumer that wanted to group had to re-derive it. None did.
    const [item] = scopeItemsFromPermissions([
      {
        key: "financial:holdings",
        domainKey: "financial",
        domainTitle: "Financial",
        label: "Holdings",
        description: "What you own",
        stateLabel: "Ask first",
      } as never,
    ]);
    expect(item.domainKey).toBe("financial");
    expect(item.domainLabel).toBe("Financial");
    expect(item.badge).toBe("Ask first");
  });

  it("never rewrites an authored label", () => {
    // Labels are authored upstream. Shortening "Employment status" to "status"
    // names a different field, which is why the last-word heuristic was reverted.
    const [item] = scopeItemsFromRequestable([
      {
        scopeRef: "attr.professional.employment_status",
        label: "Employment status",
        description: null,
        domain: "professional",
        sensitivity: "restricted",
        wildcard: false,
      },
    ]);
    expect(item.label).toBe("Employment status");
    expect(item.badge).toBe("Highly sensitive");
  });

  it("derives a domain for a pending request that carries none", () => {
    const item = scopeItemFromPendingConsent({
      request_id: "req-1",
      scope: "attr.location.saved_places",
      scope_description: "Your saved places",
    } as never);
    expect(item?.domainKey).toBe("location");
    expect(item?.label).toBe("Your saved places");
  });

  it("drops a pending request with no id rather than making one up", () => {
    expect(scopeItemFromPendingConsent({ request_id: "  " } as never)).toBeNull();
  });
});

describe("sensitivityBadge", () => {
  it("badges only what is worth interrupting someone for", () => {
    expect(sensitivityBadge("restricted")).toBe("Highly sensitive");
    expect(sensitivityBadge("sensitive")).toBe("Sensitive");
    expect(sensitivityBadge("standard")).toBeNull();
    expect(sensitivityBadge(null)).toBeNull();
  });
});

describe("groupScopeItems", () => {
  it("preserves first-seen order so the list never reshuffles under a person", () => {
    const items = scopeItemsFromRequestable([
      { scopeRef: "attr.b.one", label: "B one", description: null, domain: "b", sensitivity: null, wildcard: false },
      { scopeRef: "attr.a.one", label: "A one", description: null, domain: "a", sensitivity: null, wildcard: false },
      { scopeRef: "attr.b.two", label: "B two", description: null, domain: "b", sensitivity: null, wildcard: false },
    ]);
    const groups = groupScopeItems(items);
    expect(groups.map((g) => g.domainKey)).toEqual(["b", "a"]);
    expect(groups[0]!.items).toHaveLength(2);
  });
});

describe("filterScopeItems", () => {
  const items = scopeItemsFromRequestable([
    { scopeRef: "attr.a.home", label: "Home address", description: "Where you live", domain: "a", sensitivity: null, wildcard: false },
    { scopeRef: "attr.b.card", label: "Saved card", description: null, domain: "b", sensitivity: null, wildcard: false },
  ]);

  it("matches label, description and domain", () => {
    expect(filterScopeItems(items, "home")).toHaveLength(1);
    expect(filterScopeItems(items, "where you live")).toHaveLength(1);
    expect(filterScopeItems(items, "zzz")).toHaveLength(0);
  });

  it("returns everything for an empty query", () => {
    expect(filterScopeItems(items, "   ")).toHaveLength(2);
  });
});

describe("mergeScopeItems", () => {
  const make = (id: string) => ({
    id, label: id, domainKey: "d", domainLabel: "D", searchText: id,
  });

  it("is idempotent, because a live channel can deliver the same id twice", () => {
    const once = mergeScopeItems([make("a")], [make("b")]);
    const twice = mergeScopeItems(once, [make("b")]);
    expect(twice.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("is order-independent", () => {
    const left = mergeScopeItems([make("a")], [make("b")]).map((i) => i.id).sort();
    const right = mergeScopeItems([make("b")], [make("a")]).map((i) => i.id).sort();
    expect(left).toEqual(right);
  });
});

describe("SCOPE_SEARCH_THRESHOLD", () => {
  it("is the value person-profile-page had worked out", () => {
    expect(SCOPE_SEARCH_THRESHOLD).toBe(6);
  });
});
