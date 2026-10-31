import { describe, expect, it } from "vitest";

import { marketplaceInvestorEvidenceLinks } from "@/lib/marketplace/investor-discovery";
import type { MarketplaceInvestor } from "@/lib/services/ria-service";

function evidence(
  overrides: NonNullable<MarketplaceInvestor["evidence"]>
): NonNullable<MarketplaceInvestor["evidence"]> {
  return overrides;
}

describe("marketplaceInvestorEvidenceLinks", () => {
  it("renders only the SEC Form 13F filing link from distinct SEC evidence surfaces", () => {
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
        id: "sec-accession:0000123456-26-000001",
        label: "SEC Form 13F - 0000123456-26-000001",
        url: "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/xslForm13F_X02/primary_doc.xml",
      },
    ]);
  });

  it("does not surface submissions or company-page URLs without a 13F filing", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://data.sec.gov/submissions/CIK0000123456.json",
          "https://www.sec.gov/edgar/browse/?CIK=0000123456",
        ],
        forms: [{ form: "13F", last_filed_at: "2026-03-31" }],
      })
    );

    expect(links).toEqual([]);
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

  it("keeps only the first distinct SEC Form 13F filing visible", () => {
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
    ]);
  });

  it("honors an explicit zero-link limit", () => {
    const links = marketplaceInvestorEvidenceLinks(
      evidence({
        source_urls: [
          "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/primary_doc.xml",
        ],
        forms: [{ form: "13F", last_filed_at: "2026-03-31" }],
      }),
      0
    );

    expect(links).toEqual([]);
  });
});
