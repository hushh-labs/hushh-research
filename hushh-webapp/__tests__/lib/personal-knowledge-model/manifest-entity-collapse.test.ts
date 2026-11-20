import { describe, expect, it } from "vitest";

import {
  buildPersonalKnowledgeModelStructureArtifacts,
  projectDomainDataForScope,
} from "@/lib/personal-knowledge-model/manifest";

/**
 * A manifest describes the SHAPE of a domain, not its contents. An `entities`
 * map is a collection keyed by entity id, so walking each key made the path
 * list grow with the number of holdings: a real portfolio produced ~1232 paths
 * against the server's 1000-path cap, and `POST /api/pkm/store-domain` rejected
 * the save with a 422 that surfaced as "Backend returned failure on store".
 * It also wrote every ticker the person owns into a structure descriptor.
 */
function financialDomain(tickers: string[]): Record<string, unknown> {
  return {
    financial: {
      holdings: {
        entities: Object.fromEntries(
          tickers.map((ticker) => [
            ticker,
            {
              ticker,
              shares: 10,
              cost_basis: 100.5,
              market_value: 1200,
              sector: "Technology",
            },
          ]),
        ),
      },
    },
  };
}

function analysisHistoryDomain(tickers: string[]): Record<string, unknown> {
  return {
    analysis_history: {
      ...Object.fromEntries(
        tickers.map((ticker) => [
          ticker,
          [
            {
              ticker,
              decision: "hold",
              confidence: 0.8,
              final_statement: `Synthetic ${ticker} history`,
            },
          ],
        ]),
      ),
      domain_intent: {
        primary: "financial",
        secondary: "analysis_history",
      },
    },
  };
}

const TEN = Array.from({ length: 10 }, (_, index) => `T${index}`);
const TWO_HUNDRED = Array.from({ length: 200 }, (_, index) => `T${index}`);

/**
 * Same 1000-path cap, a different way to hit it. `documents.statements[]`
 * (portfolio-review-view.tsx's per-import snapshot) archives a near-complete
 * second copy of the reviewed portfolio: `canonical_v2` is the whole
 * portfolio again, `analytics_v2` duplicates top-level `analytics`, and
 * `raw_extract_v2`/`quality_report_v2` are the parser's own diagnostic
 * detail. None of it is entities-keyed, so the entity/analysis_history
 * collapse above never touches it -- every statement re-declares the full
 * breadth of holding fields as its own distinctly-named paths. The
 * demo/sample template has none of these fields, so "Load sample brokerage"
 * never hits this; a real statement import does.
 */
function richHolding(ticker: string): Record<string, unknown> {
  return {
    symbol: ticker,
    symbol_cusip: null,
    identifier_type: "ticker",
    symbol_quality: "aggregated",
    symbol_trust_tier: "tradable_ticker",
    symbol_trust_reason: "symbol_master_match",
    tradable: true,
    instrument_kind: "other",
    is_cash_equivalent: false,
    is_investable: true,
    debate_eligible: true,
    optimize_eligible: true,
    analyze_eligible: true,
    analyze_eligible_reason: "eligible_sec_common_equity",
    symbol_source: "statement_ticker",
    symbol_kind: "us_common_equity_ticker",
    security_listing_status: "sec_common_equity",
    is_sec_common_equity_ticker: true,
    name: `Synthetic ${ticker} Inc`,
    quantity: 10,
    price: 100.5,
    price_per_unit: 100.5,
    market_value: 1005,
    cost_basis: 900,
    unrealized_gain_loss: 105,
    unrealized_gain_loss_pct: 11.67,
    asset_type: "Equities",
    sector: "Technology",
    industry: "Software",
    sector_tags: ["Technology", "Software"],
    metadata_confidence: 1,
    estimated_annual_income: 12,
    est_yield: 1.2,
    confidence: 0.85,
    provenance: { source: "statement_llm_parse", aggregated_from_lots: 1 },
  };
}

function realisticStatementSnapshot(tickers: string[]) {
  const holdings = tickers.map(richHolding);
  const accountSummary = { ending_value: 100000, cash_balance: 5000 };
  const analytics = { health_score: 72, sector_shift: { Technology: 0.1 } };
  return {
    id: "stmt_1",
    holdings,
    account_summary: accountSummary,
    canonical_v2: {
      account_info: { brokerage: "Synthetic Brokerage" },
      account_summary: accountSummary,
      holdings,
    },
    raw_extract_v2: {
      detailed_holdings: holdings,
      parser_notes: "synthetic",
    },
    quality_report_v2: {
      raw_count: holdings.length,
      validated_count: holdings.length,
      per_holding: holdings.map((h) => ({ symbol: (h as { symbol: string }).symbol, confidence: 0.85 })),
    },
    analytics_v2: analytics,
  };
}

function realisticFinancialDomain(tickers: string[], statementCount: number): Record<string, unknown> {
  const holdings = tickers.map(richHolding);
  return {
    financial: {
      portfolio: { holdings },
      analytics: { health_score: 72, sector_shift: { Technology: 0.1 } },
      documents: {
        statements: Array.from({ length: statementCount }, () => realisticStatementSnapshot(tickers)),
      },
    },
  };
}

describe("manifest entity-map collapse", () => {
  it("excludes private entity entries and refuses leaves that became containers", () => {
    expect(projectDomainDataForScope({
      domain: "professional", scope: "attr.professional.work.*",
      domainData: { work: { entities: {
        public: { summary: "Synthetic" },
        _private: { summary: "Hidden" },
        changed: { summary: { secret: "Not a reviewed leaf" } },
      } } },
      approvedPaths: ["work.entities._entities.summary"],
    })).toEqual({ professional: { work: { entities: { public: { summary: "Synthetic" } } } } });
  });

  it("keeps array fields attached to their original item when siblings are absent", () => {
    const projected = projectDomainDataForScope({
      domain: "professional",
      scope: "attr.professional.projects.*",
      domainData: { projects: [{ title: "Synthetic first" }, { status: "Synthetic second" }] },
      approvedPaths: ["projects._items.title", "projects._items.status"],
    });
    expect(projected).toEqual({ professional: { projects: [{ title: "Synthetic first" }, { status: "Synthetic second" }] } });
  });

  it("does not grow the path list as entities are added", () => {
    const small = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: financialDomain(TEN),
    });
    const large = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: financialDomain(TWO_HUNDRED),
    });

    expect(large.structureDecision.json_paths).toEqual(
      small.structureDecision.json_paths,
    );
    // Twenty times the holdings, same shape -- and far below the 1000 cap.
    expect(large.structureDecision.json_paths.length).toBeLessThan(20);
  });

  it("keeps entity ids out of the manifest", () => {
    const { structureDecision } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: financialDomain(["AAPL", "MSFT", "NVDA"]),
    });

    const serialized = structureDecision.json_paths.join(" ");
    expect(serialized).not.toContain("AAPL");
    expect(serialized).not.toContain("MSFT");
    expect(serialized).not.toContain("NVDA");
    expect(serialized).toContain("_entities");
  });

  it("still resolves the top-level consent scope", () => {
    const { structureDecision } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: financialDomain(TEN),
    });

    // Consent is scoped on the first path segment, so collapsing deeper
    // segments must leave the scope vocabulary untouched.
    expect(structureDecision.top_level_scope_paths).toEqual(["financial"]);
  });

  it("still projects each entity's values under its own id", () => {
    const domainData = financialDomain(["AAPL", "MSFT"]);
    const { structureDecision } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData,
    });

    const projected = projectDomainDataForScope({
      domain: "financial",
      scope: "attr.financial.*",
      domainData,
      approvedPaths: structureDecision.externalizable_paths,
    });

    // The manifest no longer enumerates entities, but a collapsed path still
    // has to resolve every entity behind it and say which one each value
    // belongs to -- otherwise the shared projection loses its subject.
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("AAPL");
    expect(serialized).toContain("MSFT");
  });

  it("collapses Financial analysis history by ticker without hiding metadata", () => {
    const small = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: analysisHistoryDomain(["AAPL"]),
    });
    const large = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: analysisHistoryDomain(["AAPL", "MSFT", "NVDA"]),
    });

    expect(large.structureDecision.json_paths).toEqual(
      small.structureDecision.json_paths,
    );
    expect(large.structureDecision.json_paths).toContain(
      "analysis_history._entities._items.final_statement",
    );
    expect(large.structureDecision.json_paths).toContain("analysis_history.domain_intent.primary");
    expect(large.structureDecision.json_paths.join(" ")).not.toMatch(/AAPL|MSFT|NVDA/);

    const projected = projectDomainDataForScope({
      domain: "financial",
      scope: "attr.financial.*",
      domainData: analysisHistoryDomain(["AAPL", "MSFT"]),
      approvedPaths: large.structureDecision.externalizable_paths,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("AAPL");
    expect(serialized).toContain("MSFT");
  });

  it("declaring these branches opaque removes real path volume, not just a token amount", () => {
    // Regression: "Load sample brokerage" (no canonical_v2/raw_extract_v2/
    // quality_report_v2/analytics_v2 in the demo template) always saved
    // fine; a real statement import immediately afterward failed to save
    // with a generic "Backend returned failure on store" -- reported on
    // 2026-09-27, UAT, a 10-holding portfolio. This isolates what these four
    // branches alone would have cost if walked (measured by re-manifesting
    // the same content under a plain, non-opaque key) against what they
    // actually cost now -- the synthetic holding shape here is a stand-in
    // for the real one (richer in production: raw_extract_v2 in particular
    // carries the parser's own unvalidated LLM extraction, not just the
    // normalized fields modeled here), so this is a lower bound on the real
    // saving, not the exact reported count.
    const statement = realisticStatementSnapshot(TEN);
    const archiveContent = {
      canonical_v2: statement.canonical_v2,
      raw_extract_v2: statement.raw_extract_v2,
      quality_report_v2: statement.quality_report_v2,
      analytics_v2: statement.analytics_v2,
    };
    const withOpaqueKeys = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: { financial: { archive_probe: archiveContent } },
    }).structureDecision.json_paths.length;
    const sameContentRenamed = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: {
        financial: {
          // Identical content, nested under a key that doesn't match any
          // opacity rule -- what walking it in full actually costs.
          archive_probe_unwalked: {
            canonical_v2_renamed: archiveContent.canonical_v2,
            raw_extract_v2_renamed: archiveContent.raw_extract_v2,
            quality_report_v2_renamed: archiveContent.quality_report_v2,
            analytics_v2_renamed: archiveContent.analytics_v2,
          },
        },
      },
    }).structureDecision.json_paths.length;

    expect(withOpaqueKeys).toBeLessThan(20);
    expect(sameContentRenamed).toBeGreaterThan(80);
  });

  it("does not grow a statement import's path count with statement count", () => {
    const one = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: realisticFinancialDomain(TEN, 1),
    });
    const five = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: realisticFinancialDomain(TEN, 5),
    });

    expect(five.structureDecision.json_paths).toEqual(one.structureDecision.json_paths);
  });

  it("declares canonical_v2/raw_extract_v2/quality_report_v2/analytics_v2 as opaque, not walked into", () => {
    const { structureDecision } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: realisticFinancialDomain(["AAPL"], 1),
    });

    const paths = structureDecision.json_paths;
    // The branch itself is still one declared node (the data is still
    // stored and still counted as present) -- only its children are opaque.
    for (const key of ["canonical_v2", "raw_extract_v2", "quality_report_v2", "analytics_v2"]) {
      const branchPath = `financial.documents.statements._items.${key}`;
      expect(paths).toContain(branchPath);
      expect(paths.some((p) => p.startsWith(`${branchPath}.`))).toBe(false);
    }
    // The ticker never leaks in through the still-walked sibling paths either.
    expect(paths.join(" ")).not.toMatch(/AAPL/);
    // None of the opaque branches can be independently requested -- object
    // nodes are never externalizable regardless of this fix, but assert it
    // here so a future refactor of isExternalizablePath can't silently
    // start publishing this archive.
    for (const key of ["canonical_v2", "raw_extract_v2", "quality_report_v2", "analytics_v2"]) {
      expect(structureDecision.externalizable_paths).not.toContain(
        `financial.documents.statements._items.${key}`,
      );
    }
  });
});
