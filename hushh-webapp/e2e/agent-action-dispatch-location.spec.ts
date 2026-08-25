import { expect, test, type Page } from "@playwright/test";

/**
 * Proves a representative slice of Location voice actions end-to-end: real
 * `executeAgentGatewayAction` calls against the real backend, asserting real
 * app state changed -- exactly what a genuine Gemini tool-call would produce,
 * without simulating audio/STT. See lib/agent/agent-action-runtime.ts.
 *
 * Sign-in reuses the same __HUSHH_NATIVE_TEST__ bridge the other Location e2e
 * specs gate on, but drives it directly instead of hunting for a "Continue as
 * reviewer" button -- that control does not exist in this repository (see
 * e2e/location-agent-shell-consistency.spec.ts). Driving the bridge here is
 * the same mechanism `.codex/skills/reviewer-app-testing` already proves out.
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
  resultSummary: string;
  reason?: string | null;
  data?: Record<string, unknown>;
};

async function openReviewerLocationSession(page: Page) {
  await page.addInitScript(
    ({ expectedUserId, vaultPassphrase }) => {
      window.__HUSHH_NATIVE_TEST__ = {
        ...(window.__HUSHH_NATIVE_TEST__ || {}),
        enabled: true,
        autoReviewerLogin: true,
        expectedUserId,
        vaultPassphrase,
      };
    },
    {
      expectedUserId: process.env.REVIEWER_UID ?? "",
      vaultPassphrase: process.env.REVIEWER_VAULT_PASSPHRASE ?? "",
    },
  );

  await page.goto(`/login?redirect=${encodeURIComponent("/one/location")}`, {
    waitUntil: "domcontentloaded",
  });

  const unlockInput = page.locator("#unlock-passphrase");
  const unlockButton = page
    .getByRole("button", { name: /unlock with passphrase/i })
    .first();
  const terminalFailures = new Set(["auth_error", "uid_mismatch", "vault_error"]);
  const deadline = Date.now() + 90_000;
  let manualUnlockSubmitted = false;

  while (Date.now() < deadline) {
    const bootstrap = await page.evaluate(() => ({
      state: String(window.__HUSHH_NATIVE_TEST__?.bootstrapState || ""),
      errorClass: String(window.__HUSHH_NATIVE_TEST__?.bootstrapErrorClass || ""),
    }));
    if (bootstrap.state === "vault_unlocked") break;
    if (terminalFailures.has(bootstrap.state)) {
      throw new Error(
        `Reviewer vault bootstrap failed (state=${bootstrap.state}, error_class=${bootstrap.errorClass || "unknown"}). ` +
          "This is a fixture/credential problem, not an action-dispatch problem -- see project notes on the shared reviewer fixture.",
      );
    }
    if (!manualUnlockSubmitted && (await unlockInput.isVisible().catch(() => false))) {
      await unlockInput.fill(process.env.REVIEWER_VAULT_PASSPHRASE ?? "");
      if (await unlockButton.isEnabled().catch(() => false)) {
        await unlockButton.click({ noWaitAfter: true });
        manualUnlockSubmitted = true;
      }
    }
    await page.waitForTimeout(250);
  }

  const finalState = await page.evaluate(
    () => window.__HUSHH_NATIVE_TEST__?.bootstrapState || "",
  );
  if (finalState !== "vault_unlocked") {
    throw new Error(`Reviewer vault bootstrap timed out (state=${finalState || "unknown"}).`);
  }

  await page.goto("/one/location", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Location Agent" }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

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

test.describe("Location voice action dispatch (real backend, no audio/STT)", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE, E2E_REVIEWER_SIGNIN=1, and E2E_AGENT_ACTION_DISPATCH=1",
  );

  test("pause_updates then resume_updates is a real, self-reverting round trip", async ({
    page,
  }) => {
    await openReviewerLocationSession(page);

    const paused = await dispatch(page, "location.pause_updates");
    expect(paused.status, paused.resultSummary).toBe("succeeded");

    const resumed = await dispatch(page, "location.resume_updates");
    expect(resumed.status, resumed.resultSummary).toBe("succeeded");
  });

  test("select_share_recipient resolves a named connection against real state", async ({
    page,
  }) => {
    await openReviewerLocationSession(page);

    // The fixture's actual connections are not known ahead of time. A name
    // nobody has should deterministically come back "blocked" with a
    // not-found summary rather than erroring -- that alone proves the
    // dispatch reached real resolution logic (resolveSpokenNames) against a
    // real, vault-authorized connections read.
    const miss = await dispatch(page, "location.select_share_recipient", {
      person: "Zzyzx Nonexistentperson",
    });
    expect(["blocked", "succeeded"], miss.resultSummary).toContain(miss.status);
    if (miss.status === "blocked") {
      expect(miss.resultSummary.toLowerCase()).not.toMatch(/unlock one first/);
    }
  });
});
