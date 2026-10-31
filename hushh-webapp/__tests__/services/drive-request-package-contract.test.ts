import { describe, expect, it } from "vitest";
import { parseAgentDocumentPackage } from "@/lib/services/drive-request-package-contract";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

describe("discovery request package contract", () => {
  it("accepts discovery membership without model scores while retaining approval binding", () => {
    const agentPackage = { status: "ready", revision: 2, digest: "a".repeat(64), selectedCount: 2, selectedFileCount: 2,
      selectedFiles: [{ position: 1, name: "Arbitrary 7.pdf" }, { position: 2, name: "Record K.docx" }],
      evaluatedCount: 0, candidateCount: 2, confidenceScore: null, confidenceBasis: "provider_search", importanceScore: null,
      suggestedPriceCents: 500, priceReason: "Fixed price", summary: "Drive search matches", coverageStatus: "unknown",
      gaps: ["File contents were not read."], canAllow: true };
    expect(parseAgentDocumentPackage(agentPackage)).toEqual(agentPackage);
    for (const invalid of [{ confidenceScore: 95 }, { importanceScore: 10 }, { evaluatedCount: 2 }, { suggestedPriceCents: 1000 },
      { digest: null }, { selectedFileCount: 1 }, { confidenceBasis: "model_assessment" }]) {
      expect(() => parseAgentDocumentPackage({ ...agentPackage, ...invalid })).toThrow(DriveSharingError);
    }
  });
});
