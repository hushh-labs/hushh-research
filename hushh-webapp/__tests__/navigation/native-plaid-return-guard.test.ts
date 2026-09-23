import { describe, expect, it } from "vitest";

import {
  isNativePlaidLinkOpen,
  markNativePlaidLinkOpened,
} from "@/lib/kai/brokerage/native-plaid-session";
import { shouldFollowDeepLink } from "@/lib/navigation/use-deep-link-return";

describe("native Plaid return guard", () => {
  it("leaves the Plaid return to the open native session", () => {
    const close = markNativePlaidLinkOpened();
    expect(isNativePlaidLinkOpen()).toBe(true);
    expect(shouldFollowDeepLink("/one/kai/plaid/oauth/return?oauth_state_id=x")).toBe(false);
    expect(shouldFollowDeepLink("/kai/plaid/oauth/return")).toBe(false);
    // Any other link is still followed while Link is open.
    expect(shouldFollowDeepLink("/one/feed")).toBe(true);
    close();
    close(); // idempotent
    expect(isNativePlaidLinkOpen()).toBe(false);
  });

  it("follows the Plaid return when no native session is open (cold start)", () => {
    expect(shouldFollowDeepLink("/one/kai/plaid/oauth/return?oauth_state_id=x")).toBe(true);
  });
});
