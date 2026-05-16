import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  },
}));

import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { CacheService } from "@/lib/services/cache-service";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function centerPayload(marker: string) {
  return {
    user_id: "user-1",
    persona_state: {
      user_id: "user-1",
      personas: ["investor"],
      last_active_persona: "investor",
      active_persona: "investor",
      primary_nav_persona: "investor",
      ria_setup_available: false,
      ria_switch_available: false,
      dev_ria_bypass_allowed: false,
      investor_marketplace_opt_in: false,
      iam_schema_ready: true,
      mode: "full",
    },
    summary: {
      incoming_requests: 0,
      outgoing_requests: 0,
      active_grants: marker === "token-a" ? 1 : 2,
      invites: 0,
      history: 0,
      developer_requests: 0,
      ria_roster: {
        total: 0,
        approved: 0,
        pending: 0,
        invited: 0,
      },
    },
    incoming_requests: [],
    outgoing_requests: [],
    active_grants: [{ id: marker }],
    history: [],
    invites: [],
    developer_requests: [],
    requestor_groups: {
      pending: [],
      active: [],
      previous: [],
    },
  };
}

describe("ConsentCenterService cache isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
  });

  it("does not reuse cached consent center data across different bearer tokens", async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(centerPayload("token-a")))
      .mockResolvedValueOnce(jsonResponse(centerPayload("token-b")));

    const first = await ConsentCenterService.getCenter({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
      view: "active",
    });
    const second = await ConsentCenterService.getCenter({
      idToken: "consent-token-b",
      userId: "user-1",
      actor: "investor",
      view: "active",
    });
    const firstAgain = await ConsentCenterService.getCenter({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
      view: "active",
    });

    expect(first.active_grants[0]?.id).toBe("token-a");
    expect(second.active_grants[0]?.id).toBe("token-b");
    expect(firstAgain.active_grants[0]?.id).toBe("token-a");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached consent summaries across different bearer tokens", async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "user-1",
          actor: "investor",
          mode: "consents",
          counts: { pending: 0, active: 1, previous: 0 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "user-1",
          actor: "investor",
          mode: "consents",
          counts: { pending: 0, active: 2, previous: 0 },
        })
      );

    const first = await ConsentCenterService.getSummary({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
    });
    const second = await ConsentCenterService.getSummary({
      idToken: "consent-token-b",
      userId: "user-1",
      actor: "investor",
    });
    const firstAgain = await ConsentCenterService.getSummary({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
    });

    expect(first.counts.active).toBe(1);
    expect(second.counts.active).toBe(2);
    expect(firstAgain.counts.active).toBe(1);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached consent lists across different bearer tokens", async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "user-1",
          actor: "investor",
          mode: "consents",
          surface: "active",
          query: "",
          page: 1,
          limit: 20,
          total: 1,
          has_more: false,
          items: [{ id: "token-a" }],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "user-1",
          actor: "investor",
          mode: "consents",
          surface: "active",
          query: "",
          page: 1,
          limit: 20,
          total: 1,
          has_more: false,
          items: [{ id: "token-b" }],
        })
      );

    const first = await ConsentCenterService.listEntries({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
      surface: "active",
    });
    const second = await ConsentCenterService.listEntries({
      idToken: "consent-token-b",
      userId: "user-1",
      actor: "investor",
      surface: "active",
    });
    const firstAgain = await ConsentCenterService.listEntries({
      idToken: "consent-token-a",
      userId: "user-1",
      actor: "investor",
      surface: "active",
    });

    expect(first.items[0]?.id).toBe("token-a");
    expect(second.items[0]?.id).toBe("token-b");
    expect(firstAgain.items[0]?.id).toBe("token-a");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
