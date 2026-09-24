import { expect, test } from "@playwright/test";

import {
  openReviewerSession,
  reviewerIdentityFromEnv,
} from "./helpers/reviewer-session";

/**
 * Runtime proof for the layer ladder: a menu opened from inside the profile
 * pane must be the element under the pointer, not the pane behind it.
 *
 * The unit contract (__tests__/ui/layer-order.contract.test.ts) pins the
 * tokens; this is the only place that proves the browser stacks them the way
 * the ladder says. It drives the Accent picker because that is the control
 * that was reported "gone": the picker was fine, the list opened behind the
 * pane. It also proves the pick sticks (html[data-accent="gold"] and the
 * resolved accent token) so Molten Gold is verifiably reachable again.
 */

const identity = reviewerIdentityFromEnv(
  "REVIEWER_UID",
  "REVIEWER_VAULT_PASSPHRASE",
);
const enabled = identity !== null && process.env.E2E_REVIEWER_SIGNIN === "1";

test.describe("profile pane layer order", () => {
  test.skip(
    !enabled,
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE and E2E_REVIEWER_SIGNIN=1",
  );

  test("the Accent picker opens above the pane and Molten Gold applies", async ({
    page,
  }) => {
    // Reviewer sign-in mints a review-mode session through the backend and
    // Firebase; on a cold dev server that alone can pass the 30s default.
    test.setTimeout(180_000);
    await openReviewerSession(page, identity!, {
      redirectTo: "/one?profile_pane=1&profile_panel=preferences",
      readyHeading: null,
    });

    const pane = page.getByTestId("profile-pane");
    await expect(pane).toBeVisible({ timeout: 60_000 });

    const trigger = page.getByRole("combobox", { name: "App accent color" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    // The element under the middle of the open list must be the list (or a
    // descendant), never the pane. This is the assertion that fails when the
    // transient tier sits below the sheet tier.
    const topmostIsListbox = await listbox.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit !== null && node.contains(hit);
    });
    expect(topmostIsListbox).toBe(true);

    await page.getByRole("option", { name: "Molten Gold" }).click();

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.getAttribute("data-accent"),
        ),
      )
      .toBe("gold");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--app-accent")
        .trim()
        .toLowerCase(),
    );
    expect(accent).toBe("#d4a574");

    // Leave the reviewer fixture as it was found.
    await trigger.click();
    await page.getByRole("option", { name: "iOS Blue" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.getAttribute("data-accent"),
        ),
      )
      .toBeNull();
  });
});
