import { describe, expect, it } from "vitest";

import { resolveCachedAgentMetrics } from "@/components/dashboard/one-agent-roster";
import type { OneLocationState } from "@/lib/one-location/types";
import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";
import { CACHE_KEYS, CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import type { PersonalKnowledgeModelMetadata } from "@/lib/services/personal-knowledge-model-service";
import type { RiaHomeResponse } from "@/lib/services/ria-service";

describe("One agent roster cache metrics", () => {
  it("uses each available sub-agent cache summary without fetching", () => {
    const userId = "roster-cache-metrics";
    const cache = CacheService.getInstance();
    cache.invalidateUser(userId);

    cache.set<KaiHomeInsightsV2>(
      CACHE_KEYS.KAI_MARKET_HOME(userId, "default", 7),
      { movers: { gainers: [{ symbol: "NVDA", change_pct: 6.4 }] } } as KaiHomeInsightsV2,
      CACHE_TTL.SHORT,
    );
    cache.set<RiaHomeResponse>(
      CACHE_KEYS.RIA_HOME(userId),
      { counts: { active_clients: 3 } } as RiaHomeResponse,
      CACHE_TTL.SHORT,
    );
    cache.set(CACHE_KEYS.PENDING_CONSENTS(userId), [{ id: "pending-1" }], CACHE_TTL.SHORT);
    cache.set<OneLocationState>(
      CACHE_KEYS.ONE_LOCATION_STATE(userId),
      { ownerGrants: [{ status: "active" }], receivedGrants: [], recipients: [], requests: [], referrals: [], publicInvites: [], publicInviteSubmissions: [], capabilityScopes: [] } as OneLocationState,
      CACHE_TTL.SHORT,
    );
    cache.set<PersonalKnowledgeModelMetadata>(
      CACHE_KEYS.PKM_METADATA(userId),
      { totalAttributes: 12 } as PersonalKnowledgeModelMetadata,
      CACHE_TTL.SHORT,
    );
    cache.set(CACHE_KEYS.DEVELOPER_ACCESS(userId), { systems: [{ id: "crm" }, { id: "gmail" }] }, CACHE_TTL.SHORT);

    expect(resolveCachedAgentMetrics(userId)).toMatchObject({
      finance: { value: "NVDA", label: "+6.40%" },
      ria: { value: "3", label: "active clients" },
      email: { value: "1", label: "approval waiting" },
      consent: { value: "1", label: "request to review" },
      location: { value: "1", label: "live share" },
      pkm: { value: "12", label: "saved details" },
      "connected-systems": { value: "2", label: "connected systems" },
    });
  });
});
