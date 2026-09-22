import { afterEach, describe, expect, it, vi } from "vitest";

import { HushhConsentWeb } from "@/lib/capacitor/plugins/consent-web";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * `scope_str` is part of a TrustLink's signature. The plugin rebuilds the link
 * field by field in both directions, so dropping it here would make a link the
 * backend just signed fail its own verification.
 */
describe("TrustLink verbatim scope round-trip", () => {
  it("keeps the delegated scope from create-link and sends it back to verify-link", async () => {
    const created = {
      from_agent: "agent_one",
      to_agent: "agent_kai",
      scope: "attr.food.recipes.*",
      scope_str: "attr.food.recipes.*",
      created_at: 1,
      expires_at: 2,
      signed_by_user: "user_1",
      signature: "sig",
      session_id: "sess_a",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => created })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new HushhConsentWeb();
    const link = await plugin.createTrustLink({
      fromAgent: "agent_one",
      toAgent: "agent_kai",
      scope: "attr.food.recipes.*",
      signedByUser: "user_1",
      sessionId: "sess_a",
    });

    // The narrow authority survives the response mapping.
    expect(link.scopeStr).toBe("attr.food.recipes.*");

    await plugin.verifyTrustLink({
      link,
      requiredScope: "attr.food.recipes.*",
      expectedSessionId: "sess_a",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    expect(body.link.scope_str).toBe("attr.food.recipes.*");
  });

  it("sends an empty verbatim scope for a legacy link rather than dropping the field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await new HushhConsentWeb().verifyTrustLink({
      link: {
        fromAgent: "agent_one",
        toAgent: "agent_kai",
        scope: "agent.kai.analyze",
        createdAt: 1,
        expiresAt: 2,
        signedByUser: "user_1",
        signature: "sig",
      },
      requiredScope: "agent.kai.analyze",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.link.scope_str).toBe("");
  });
});
