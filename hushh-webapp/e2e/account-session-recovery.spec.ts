import { expect, type Page, test } from "@playwright/test";

const ACCOUNT_NOT_FOUND_NOTICE =
  "Account not found. Redirecting you to login screen.";

function captureHydrationFailures(page: Page): string[] {
  const failures: string[] = [];
  const record = (message: string) => {
    if (/hydration failed|hydration mismatch/i.test(message)) {
      failures.push(message);
    }
  };
  page.on("console", (message) => record(message.text()));
  page.on("pageerror", (error) => record(error.message));
  return failures;
}

test.describe("terminal account-session recovery", () => {
  // A CI dev server compiles this route on its first navigation. This is a
  // startup allowance, not the bounded account-validation/recovery budget.
  test.setTimeout(90_000);
  test("shows the exact one-shot notice and preserves the intended destination", async ({
    page,
  }) => {
    const hydrationFailures = captureHydrationFailures(page);
    await page.goto(
      "/login?redirect=%2Fone%2Ffeed&auth_notice=account_not_found",
    );

    await expect(page.getByText(ACCOUNT_NOT_FOUND_NOTICE)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/Unable to verify setup progress/i),
    ).toHaveCount(0);
    await expect(
      page.getByText(/We could not reach Vault right now/i),
    ).toHaveCount(0);

    await expect
      .poll(() => {
        const url = new URL(page.url());
        return {
          pathname: url.pathname,
          redirect: url.searchParams.get("redirect"),
          notice: url.searchParams.get("auth_notice"),
        };
      })
      .toEqual({
        pathname: "/login",
        redirect: "/one/feed",
        notice: null,
      });

    await page.reload();
    await expect(page.getByText(ACCOUNT_NOT_FOUND_NOTICE)).toHaveCount(0);
    expect(hydrationFailures).toEqual([]);
  });

  test("scrubs an untrusted notice without rendering backend text", async ({
    page,
  }) => {
    const hydrationFailures = captureHydrationFailures(page);
    await page.goto(
      "/login?redirect=%2Fone%2Ffeed&auth_notice=AUTH_ACCOUNT_NOT_FOUND%3Araw-detail",
    );

    await expect(
      page.getByText(/AUTH_ACCOUNT_NOT_FOUND:raw-detail/i),
    ).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("auth_notice"))
      .toBeNull();
    expect(new URL(page.url()).searchParams.get("redirect")).toBe("/one/feed");
    expect(hydrationFailures).toEqual([]);
  });
});
