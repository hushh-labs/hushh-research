import { expect, test, type Page } from "@playwright/test";

/**
 * Proves Circles voice actions end-to-end via the same direct
 * executeAgentGatewayAction dispatch as agent-action-dispatch-location.spec.ts
 * -- see that file for why sign-in drives the __HUSHH_NATIVE_TEST__ bridge
 * directly instead of a "Continue as reviewer" control this repo doesn't have.
 *
 * create_circle -> delete_circle is a self-cleaning round trip: the circle it
 * creates carries a run-unique name and this test deletes it before exiting,
 * so a failed run never leaves debris in the shared reviewer fixture.
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

test.describe("Circles voice action dispatch (real backend, no audio/STT)", () => {
  test.skip(
    !hasReviewerAuthority(),
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE, E2E_REVIEWER_SIGNIN=1, and E2E_AGENT_ACTION_DISPATCH=1",
  );

  test("create_circle then delete_circle is a real, self-cleaning round trip", async ({
    page,
  }) => {
    await openReviewerLocationSession(page);

    const circleName = `E2E Dispatch ${Date.now()}`;
    let created = false;
    try {
      const createResult = await dispatch(page, "location.create_circle", {
        name: circleName,
        kind: "friends",
      });
      expect(createResult.status, createResult.resultSummary).toBe("succeeded");
      created = true;

      const deleteResult = await dispatch(page, "location.delete_circle", {
        circle: circleName,
        confirmed: true,
      });
      expect(deleteResult.status, deleteResult.resultSummary).toBe("succeeded");
      created = false;
    } finally {
      if (created) {
        // Best-effort cleanup if the delete assertion above threw first.
        await dispatch(page, "location.delete_circle", {
          circle: circleName,
          confirmed: true,
        }).catch(() => undefined);
      }
    }
  });
});
