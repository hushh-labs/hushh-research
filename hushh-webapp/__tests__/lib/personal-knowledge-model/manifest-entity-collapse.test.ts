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
});
