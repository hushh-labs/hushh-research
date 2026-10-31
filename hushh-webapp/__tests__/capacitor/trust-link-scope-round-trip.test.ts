import fs from "fs";
import path from "path";

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

/**
 * The web plugin is not the only implementation of this contract. iOS and
 * Android rebuild the link field by field too, and a native build is not
 * exercised by any unit test, so this reads their source directly: dropping
 * `scope_str` there hands JS a link that can no longer verify itself.
 */
describe("native consent plugins carry the signed verbatim scope", () => {
  const WEBAPP_ROOT = path.resolve(__dirname, "../..");
  const read = (p: string) =>
    fs.readFileSync(path.join(WEBAPP_ROOT, p), "utf8");

  const NATIVE = [
    {
      name: "iOS",
      path: "ios/App/App/Plugins/HushhConsentPlugin.swift",
      // create-link response -> JS, and JS -> verify-link request body
      outbound: '"scopeStr": data["scope_str"]',
      inbound: '"scope_str": (link["scopeStr"] as? String) ?? ""',
    },
    {
      name: "Android",
      path: "android/app/src/main/java/com/hussh/app/plugins/HushhConsent/HushhConsentPlugin.kt",
      outbound: 'put("scopeStr", json.optString("scope_str", ""))',
      inbound: 'put("scope_str", link.getString("scopeStr") ?: "")',
    },
  ];

  for (const plugin of NATIVE) {
    it(`${plugin.name} keeps scope_str in both directions`, () => {
      const source = read(plugin.path);
      expect(source).toContain(plugin.outbound);
      expect(source).toContain(plugin.inbound);
    });
  }
});
