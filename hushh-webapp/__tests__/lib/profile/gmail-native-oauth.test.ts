import { describe, expect, it } from "vitest";

import { resolveNativeGmailOAuthReturnHref } from "@/lib/profile/gmail-native-oauth";

describe("resolveNativeGmailOAuthReturnHref", () => {
  it("normalizes the legacy backend Gmail OAuth callback to the canonical app route", () => {
    expect(
      resolveNativeGmailOAuthReturnHref(
        "https://one.hushh.ai/profile/gmail/oauth/return?code=abc&state=xyz",
      ),
    ).toBe("/one/profile/gmail/oauth/return?code=abc&state=xyz");
  });

  it("keeps the canonical Gmail OAuth callback route", () => {
    expect(
      resolveNativeGmailOAuthReturnHref(
        "https://one.hushh.ai/one/profile/gmail/oauth/return?code=abc&state=xyz",
      ),
    ).toBe("/one/profile/gmail/oauth/return?code=abc&state=xyz");
  });

  it("rejects untrusted Gmail OAuth callback hosts", () => {
    expect(
      resolveNativeGmailOAuthReturnHref(
        "https://example.com/profile/gmail/oauth/return?code=abc&state=xyz",
      ),
    ).toBeNull();
  });
});
