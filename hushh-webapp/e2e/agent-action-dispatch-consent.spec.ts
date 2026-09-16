import { expect, test, type Page } from "@playwright/test";

import { openReviewerSession } from "./helpers/reviewer-session";

/**
 * Proves route.consents end-to-end via the same direct
 * executeAgentGatewayAction dispatch as agent-action-dispatch-location.spec.ts
 * -- see that file for why sign-in drives the __HUSHH_NATIVE_TEST__ bridge
 * directly instead of a "Continue as reviewer" control this repo doesn't have.
 *
 * route.consents is the only wired local_handler-reachable action on this
 * surface (consent.chat.turn needs a live specialist/LLM round trip and is
 * out of scope here) -- this surface's coverage is necessarily shallower
 * than Location/Circles/Connect, not an oversight.
 */

const REQUIRED_VALUES = ["REVIEWER_UID", "REVIEWER_VAULT_PASSPHRASE"] as const;

function hasReviewerAuthority() {
  if (!REQUIRED_VALUES.every((key) => Boolean(process.env[key]?.trim()))) {
    return false;
  }
  return (
    process.env.E2E_REVIEWER_SIGNIN === "1" &&
    process.env.E2E_AGENT_ACTION_DISPATCH === "1"
  );
}

type DispatchResult = {
  status: string;
  actionId: string | null;
  routeAfter?: string | null;
  resultSummary: string;
  reason?: string | null;
};

async function dispatch(
  page: Page,
  actionId: string,
  slots: Record<string, unknown> = {},
): Promise<DispatchResult> {
  await page.waitForFunction(
    () => typeof window.__HUSHH_NATIVE_TEST__?.dispatchAgentAction === "function",
    undefined,
    { timeout: 30_000 },
  );
  return page.evaluate(
    ({ actionId: id, slots: s }) => {
      const fn = window.__HUSHH_NATIVE_TEST__?.dispatchAgentAction;
      if (!fn) throw new Error("dispatchAgentAction bridge hook is not installed.");
      return fn(id, s) as Promise<DispatchResult>;
    },
    { actionId, slots },
  );
}

test.describe("Consent voice action dispatch (real backend, no audio/STT)", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE, E2E_REVIEWER_SIGNIN=1, and E2E_AGENT_ACTION_DISPATCH=1",
  );

  test("route.consents performs a real client-side navigation to /one/consent", async ({
    page,
  }) => {
    await openReviewerSession(page, {
      userId: process.env.REVIEWER_UID ?? "",
      passphrase: process.env.REVIEWER_VAULT_PASSPHRASE ?? "",
    });

    const result = await dispatch(page, "route.consents");
    expect(result.status, result.resultSummary).toBe("succeeded");

    await page.waitForURL(/\/one\/consent(\?.*)?$/, { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe("/one/consent");
  });
});
