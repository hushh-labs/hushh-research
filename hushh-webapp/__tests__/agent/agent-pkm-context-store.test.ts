import { describe, expect, it } from "vitest";
import { buildContextText } from "../../lib/agent/agent-pkm-context-store";

type WorkingSet = Parameters<typeof buildContextText>[0]["workingSet"];

function createWorkingSet(overrides: Partial<WorkingSet> = {}): WorkingSet {
  return {
    userId: "user_123",
    metadata: {
      domains: [],
      totalAttributes: 0,
      totalSegments: 0,
    } as any,
    fullBlob: {},
    memorySnapshot: {
      cards: [],
      domainInsights: [],
      totalCards: 0,
    } as any,
    loadedAt: Date.now(),
    metadataUpdatedAt: new Date().toISOString(),
    ...overrides,
  } as WorkingSet;
}

describe("agent-pkm-context-store", () => {
  describe("buildContextText", () => {
    it("excludes runtime_secrets from the generated context text", () => {
      const workingSet = createWorkingSet({
        metadata: {
          domains: [
            {
              key: "runtime_secrets",
              attributeCount: 5,
              readableSummary: "Runtime configuration",
            },
            {
              key: "financial",
              attributeCount: 2,
              readableSummary: "Financial details",
            },
          ] as any,
        } as any,
        fullBlob: {
          runtime_secrets: {
            llm: {
              gemini_api_key: "SECRET_VALUE_123",
            },
          },
          financial: {
            accounts: ["Checking"],
          },
        },
        memorySnapshot: {
          cards: [
            {
              domain: "runtime_secrets",
              title: "Gemini Api Key: SECRET_VALUE_123",
              value: "SECRET_VALUE_123",
              detail: "Stored in Runtime Secrets > Llm > Gemini Api Key",
              searchText: "runtime_secrets llm gemini_api_key secret_value_123",
              confidence: 0.88,
              kind: "preference",
              sourceLabel: "Saved memory",
            } as any,
            {
              domain: "financial",
              title: "Checking Account: Active",
              value: "Active",
              detail: "Stored in Financial > Accounts",
              searchText: "financial accounts active",
              confidence: 0.88,
              kind: "financial",
              sourceLabel: "Saved memory",
            } as any,
          ],
          domainInsights: [
            {
              domain: "runtime_secrets",
              title: "Runtime Secrets",
              summary: "Updated Gemini Api Key",
              cardCount: 1,
              highlights: ["Updated Gemini Api Key"],
            },
            {
              domain: "financial",
              title: "Financial",
              summary: "Financial records",
              cardCount: 1,
              highlights: [],
            },
          ] as any,
        } as any,
      });

      const context = buildContextText({
        workingSet,
        message: "Hello",
        maxChars: 16000,
      });

      const text = context.text;

      // Verify that runtime_secrets is completely excluded
      expect(text).not.toContain("runtime_secrets");
      expect(text).not.toContain("Gemini");
      expect(text).not.toContain("SECRET_VALUE_123");
      expect(text).not.toContain("Runtime Secrets");
      expect(text).not.toContain("Updated Gemini Api Key");

      // Verify that other domains are still included
      expect(text).toContain("financial");
      expect(text).toContain("Financial");
      expect(text).toContain("Checking");
    });
  });
});
