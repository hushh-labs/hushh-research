import { describe, expect, it } from "vitest";

import { marketplaceInvestorEvidenceLinks } from "@/lib/marketplace/investor-discovery";
import type { MarketplaceInvestor } from "@/lib/services/ria-service";

function evidence(
  overrides: NonNullable<MarketplaceInvestor["evidence"]>
): NonNullable<MarketplaceInvestor["evidence"]> {
  return overrides;
}

describe("marketplaceInvestorEvidenceLinks", () => {
  it("labels distinct SEC evidence surfaces without generic duplicate-looking text", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://data.sec.gov/submissions/CIK0000123456.json",
          "https://www.sec.gov/edgar/browse/?CIK=0000123456",
          "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/xslForm13F_X02/primary_doc.xml",
        ],
        forms: [{ form: "13F", last_filed_at: "2026-03-31" }],
      })
    );

    expect(links).toEqual([
      {
        id: "url:https://data.sec.gov/submissions/CIK0000123456.json",
        label: "SEC submissions - CIK 0000123456",
        url: "https://data.sec.gov/submissions/CIK0000123456.json",
      },
      {
        id: "url:https://www.sec.gov/edgar/browse/?CIK=0000123456",
        label: "SEC company page - CIK 0000123456",
        url: "https://www.sec.gov/edgar/browse/?CIK=0000123456",
      },
      {
        id: "sec-accession:0000123456-26-000001",
        label: "SEC Form 13F - 0000123456-26-000001",
        url: "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/xslForm13F_X02/primary_doc.xml",
      },
    ]);
  });

  it("deduplicates exact repeated source URLs by stable URL identity", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://data.sec.gov/submissions/CIK0000123456.json",
          "https://data.sec.gov/submissions/CIK0000123456.json",
        ],
      })
    );

    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("SEC submissions - CIK 0000123456");
  });

  it("deduplicates SEC filing URLs that point to the same accession", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/primary_doc.xml",
          "https://www.sec.gov/Archives/edgar/data/123456/0000123456-26-000001-index.html",
        ],
        forms: [{ form: "13F", last_filed_at: "2026-03-31" }],
      })
    );

    expect(links).toHaveLength(1);
    expect(links[0]?.id).toBe("sec-accession:0000123456-26-000001");
    expect(links[0]?.label).toBe("SEC Form 13F - 0000123456-26-000001");
  });

  it("keeps multiple distinct SEC filings visible with unique accession labels", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/primary_doc.xml",
          "https://www.sec.gov/Archives/edgar/data/123456/000012345626000002/primary_doc.xml",
        ],
        forms: [{ form: "13F", last_filed_at: "2026-03-31" }],
      })
    );

    expect(links.map((link) => link.label)).toEqual([
      "SEC Form 13F - 0000123456-26-000001",
      "SEC Form 13F - 0000123456-26-000002",
    ]);
  });

  it("falls back to numbered filing labels only when no SEC metadata can identify the URL", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://example.com/a",
          "https://example.com/b",
        ],
      })
    );

    expect(links.map((link) => link.label)).toEqual([
      "SEC filing 1",
      "SEC filing 2",
    ]);
  });
});
