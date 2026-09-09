import { describe, expect, it } from "vitest";

import {
  CatalogBoundOneVoiceIntentResolver,
  type OneVoiceIntentContext,
} from "@/lib/voice/local-intent-resolver";
import type { OneVoiceIntentRanker } from "@/lib/voice/local-intent-ranker";

const context: OneVoiceIntentContext = {
  contextRevision: "route-1:ui-1",
  catalogVersion: "kai-action-gateway.vnext",
  route: { pathname: "/one/location", screen: "one_location" },
  availableActionIds: ["location.create_circle", "location.resume_updates"],
  executableActionIds: ["location.create_circle", "location.resume_updates"],
};

describe("catalog-bounded asynchronous resolver", () => {
  it("accepts only a ranker result from generated candidates", async () => {
    const ranker: OneVoiceIntentRanker = {
      rank: async ({ candidates }) => ({
        actionId: candidates[0]!.actionId,
        confidence: 0.96,
        margin: 0.4,
      }),
    };
    const result = await new CatalogBoundOneVoiceIntentResolver({ ranker }).resolve({
      utterance: "make a circle called Family",
      context,
      catalogVersion: context.catalogVersion,
    });
    expect(result).toMatchObject({
      disposition: "action",
      actionId: "location.create_circle",
      slots: { name: "Family" },
    });
  });

  it("clarifies instead of executing a low-confidence ranking", async () => {
    const ranker: OneVoiceIntentRanker = {
      rank: async ({ candidates }) => ({
        actionId: candidates[0]!.actionId,
        confidence: 0.55,
        margin: 0.02,
      }),
    };
    const result = await new CatalogBoundOneVoiceIntentResolver({ ranker }).resolve({
      utterance: "make a circle called Family",
      context,
      catalogVersion: context.catalogVersion,
    });
    expect(result).toMatchObject({ disposition: "clarify", reason: "ambiguous" });
  });

  it("does not accept an invented action id from a ranker", async () => {
    const ranker: OneVoiceIntentRanker = {
      rank: async () => ({ actionId: "location.send_sos", confidence: 1, margin: 1 }),
    };
    const result = await new CatalogBoundOneVoiceIntentResolver({ ranker }).resolve({
      utterance: "make a circle called Family",
      context,
      catalogVersion: context.catalogVersion,
    });
    expect(result.reason).toBe("local_model_unavailable");
    expect(result.actionId).toBeUndefined();
  });

  it("preserves a required-slot clarification after semantic ranking", async () => {
    const ranker: OneVoiceIntentRanker = {
      rank: async ({ candidates }) => ({
        actionId: candidates[0]!.actionId,
        confidence: 0.96,
        margin: 0.4,
      }),
    };
    const result = await new CatalogBoundOneVoiceIntentResolver({ ranker }).resolve({
      utterance: "create a circle",
      context,
      catalogVersion: context.catalogVersion,
    });
    expect(result).toMatchObject({
      disposition: "clarify",
      actionId: "location.create_circle",
      missingSlots: ["name"],
    });
  });

  it("does not let semantic ranking convert a governed read answer into an action", async () => {
    const ranker: OneVoiceIntentRanker = {
      rank: async () => ({
        actionId: "location.create_circle",
        confidence: 0.99,
        margin: 0.9,
      }),
    };
    const result = await new CatalogBoundOneVoiceIntentResolver({ ranker }).resolve({
      utterance: "how many circles do I have",
      context: { ...context, redactedState: { circleCount: 2 } },
      catalogVersion: context.catalogVersion,
    });
    expect(result).toMatchObject({
      disposition: "read_answer",
      readCapability: "list_my_location_circles",
      slots: { count: 2 },
    });
  });
});
