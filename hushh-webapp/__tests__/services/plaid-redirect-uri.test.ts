import { describe, expect, it } from "vitest";

import { mergePlaidCallbackQuery } from "@/lib/kai/brokerage/plaid-redirect-uri";

describe("mergePlaidCallbackQuery", () => {
  it("keeps Plaid on the minted HTTPS URI while merging native callback parameters", () => {
    const merged = mergePlaidCallbackQuery(
      "https://uat.one.hushh.ai/one/kai/plaid/oauth/return?existing=1",
      "app://localhost/one/kai/plaid/oauth/return?oauth_state=abc&code=xyz#return",
    );

    const parsed = new URL(merged);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.host).toBe("uat.one.hushh.ai");
    expect(parsed.pathname).toBe("/one/kai/plaid/oauth/return");
    expect(parsed.searchParams.get("existing")).toBe("1");
    expect(parsed.searchParams.get("oauth_state")).toBe("abc");
    expect(parsed.searchParams.get("code")).toBe("xyz");
    expect(parsed.hash).toBe("#return");
  });
});
