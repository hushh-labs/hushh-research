import { describe, expect, it } from "vitest";

import { scopeItemsFromRequestable } from "@/lib/consent/consent-scope-items";
import {
  consentScopeItemsUnder,
  resolveConsentScopeLevel,
} from "@/lib/consent/consent-scope-level";

/**
 * The catalogue a person actually meets: a couple of shallow scopes, one branch
 * that genuinely nests, one path that is both a scope in its own right and a
 * parent of narrower ones, and a wildcard.
 */
const CATALOG = scopeItemsFromRequestable([
  { scopeRef: "attr.financial.holdings", label: "Holdings", description: null, domain: "financial", sensitivity: null, wildcard: false },
  { scopeRef: "attr.financial.holdings.equities", label: "Equities", description: null, domain: "financial", sensitivity: null, wildcard: false },
  { scopeRef: "attr.financial.holdings.equities.tickers", label: "Tickers", description: null, domain: "financial", sensitivity: null, wildcard: false },
  { scopeRef: "attr.financial.income", label: "Income", description: null, domain: "financial", sensitivity: "restricted", wildcard: false },
  { scopeRef: "attr.saved_places.locations.home", label: "Home", description: null, domain: "saved_places", sensitivity: null, wildcard: false },
  { scopeRef: "attr.saved_places.locations.work", label: "Work", description: null, domain: "saved_places", sensitivity: null, wildcard: false },
  { scopeRef: "attr.professional.*", label: "Everything about work", description: null, domain: "professional", sensitivity: null, wildcard: true },
]);

const labels = (view: ReturnType<typeof resolveConsentScopeLevel>) =>
  view.entries.map((entry) => (entry.kind === "group" ? `[${entry.label}]` : entry.item.label));

describe("resolveConsentScopeLevel", () => {
  it("opens on one row per domain, not on every scope at once", () => {
    // This is the whole complaint: a flat catalogue dumps everything on one
    // screen. The top of a nested view is a short list of places to go.
    const view = resolveConsentScopeLevel({ items: CATALOG, pathStack: [] });

    expect(labels(view)).toEqual(["[Financial]", "[Saved Places]", "Everything about work"]);
    expect(view.title).toBe("All");
  });

  it("counts everything underneath a branch, not its immediate children", () => {
    const view = resolveConsentScopeLevel({ items: CATALOG, pathStack: [] });
    const financial = view.entries.find((e) => e.kind === "group" && e.label === "Financial");

    // 4 scopes live under financial, though only 2 rows appear one level in.
    expect(financial).toMatchObject({ kind: "group", childCount: 4 });
  });

  it("does NOT wrap an ordinary scope in a folder holding one row", () => {
    // attr.financial.income ends at the domain's first segment and nothing
    // extends it, so it is a row. The naive rule (leaf only when the path ends
    // exactly at this level) would make it a folder containing itself, which
    // costs a tap and hides nothing.
    const view = resolveConsentScopeLevel({ items: CATALOG, pathStack: ["financial"] });

    expect(labels(view)).toContain("Income");
    expect(labels(view)).not.toContain("[Income]");
  });

  it("keeps a scope that is ALSO a parent reachable as its own row", () => {
    // attr.financial.holdings is a real grant AND the parent of narrower ones.
    // Granting the parent is a wider decision than granting one child, so it
    // must never be folded silently into its own subtree.
    const inFinancial = resolveConsentScopeLevel({ items: CATALOG, pathStack: ["financial"] });
    expect(labels(inFinancial)).toContain("[Holdings]");

    const inHoldings = resolveConsentScopeLevel({
      items: CATALOG,
      pathStack: ["financial", "holdings"],
    });
    expect(labels(inHoldings)).toEqual(["Holdings", "[Equities]"]);
  });

  it("goes as deep as the catalogue does, with no level special-casing", () => {
    const view = resolveConsentScopeLevel({
      items: CATALOG,
      pathStack: ["financial", "holdings", "equities"],
    });

    expect(labels(view)).toEqual(["Equities", "Tickers"]);
    expect(view.crumbs).toEqual(["Financial", "Holdings", "Equities"]);
  });

  it("names the back control after the parent, never the word Back", () => {
    // Copied deliberately from the Memory route: a control labelled with where
    // it returns to tells a person where they are without a breadcrumb.
    expect(
      resolveConsentScopeLevel({ items: CATALOG, pathStack: ["financial", "holdings"] })
        .parentLabel,
    ).toBe("Financial");

    expect(
      resolveConsentScopeLevel({ items: CATALOG, pathStack: ["financial"] }).parentLabel,
    ).toBe("All");
  });

  it("never prints our grammar at a person for a wildcard", () => {
    // attr.professional.* must not render as "*".
    const view = resolveConsentScopeLevel({ items: CATALOG, pathStack: [] });
    expect(labels(view).join(" ")).not.toContain("*");

    // And it is a ROW, not a folder: a trailing "*" means "everything under
    // here", so the domain's only grant is reachable in one tap rather than
    // buried in a folder that holds exactly one thing.
    expect(labels(view)).toContain("Everything about work");
    expect(labels(view)).not.toContain("[Professional]");
  });

  it("says the path is gone rather than showing an empty screen", () => {
    // A grant can be revoked while someone is three levels inside it.
    const view = resolveConsentScopeLevel({
      items: CATALOG,
      pathStack: ["financial", "nope"],
    });

    expect(view.notFound).toBe(true);
    expect(view.entries).toEqual([]);
  });

  it("is a pure function of the list, so a revoked scope disappears at once", () => {
    // No materialised tree means nothing can go stale.
    const without = CATALOG.filter((item) => !item.id.startsWith("attr.financial"));
    const view = resolveConsentScopeLevel({ items: without, pathStack: [] });

    expect(labels(view)).not.toContain("[Financial]");
  });
});

describe("consentScopeItemsUnder", () => {
  it("collects a whole branch so one gesture can mean all of it", () => {
    const under = consentScopeItemsUnder(CATALOG, ["financial", "holdings"]);
    expect(under.map((item) => item.label).sort()).toEqual(["Equities", "Holdings", "Tickers"]);
  });

  it("returns everything at the root", () => {
    expect(consentScopeItemsUnder(CATALOG, [])).toHaveLength(CATALOG.length);
  });
});

describe("scope path segments", () => {
  it("carries the half of every scope the flat list used to discard", () => {
    const [holdings] = scopeItemsFromRequestable([
      { scopeRef: "attr.saved_places.locations.home.street", label: "Street", description: null, domain: "saved_places", sensitivity: null, wildcard: false },
    ]);
    expect(holdings.pathSegments).toEqual(["locations", "home", "street"]);
  });
});
