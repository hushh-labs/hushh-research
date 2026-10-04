import { expect, test, type Page } from "@playwright/test";

/**
 * /terms and /privacy, signed out, against a running app (BASE_URL). They are
 * the store-listing and Google consent-screen addresses, so they must render
 * for someone who has never signed in, and they now sit in the app's own
 * shell: its top bar, its Back, its column and its type.
 *
 * Before (hidden layout, own back chip, own type scale) every test below
 * fails: there is no top shell and the back control is not the shell's.
 */

async function open(page: Page, path: string, width = 393, theme: "light" | "dark" = "light") {
  await page.setViewportSize({ width, height: 852 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${path} is public`).toBe(200);
  await expect(page.locator("[data-boot-surface]")).toHaveAttribute("data-boot-phase", "idle", { timeout: 60_000 });
}

for (const [path, title] of [
  ["/terms", "Terms of Use"],
  ["/privacy", "Privacy Policy"],
] as const) {
  test(`${path} signed out sits in the core shell and Back returns to sign-in`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, path);
    await expect(page.locator("[data-top-shell-profile]")).toHaveAttribute("data-top-shell-profile", "standard");
    const trail = page.getByTestId("top-app-bar-breadcrumb-trail");
    await expect(trail).toContainText("Legal");
    await expect(trail).toContainText(title);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator("[data-legal-document]")).toBeVisible();
    // One back control: the shell's.
    await expect(page.getByRole("button", { name: "Go back" })).toHaveCount(1);
    await page.getByRole("button", { name: "Go back" }).click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: 30_000 });
  });
}

type PageGeometry = { headerLeft: number; headerRight: number; readerLeft: number; readerRight: number; overflow: number; charsPerLine: number };

async function geometry(page: Page): Promise<PageGeometry> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-app-scroll-root='true']")!;
    const header = document.querySelector<HTMLElement>("[data-testid='page-header']")!.getBoundingClientRect();
    const reader = document.querySelector<HTMLElement>("[data-legal-document]")!.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const innerRight = r.left + root.clientLeft + root.clientWidth;
    const innerLeft = r.left + root.clientLeft;
    // Characters per line of the longest paragraph, from its line boxes.
    const paragraphs = [...document.querySelectorAll<HTMLElement>("[data-testid='legal-reader-body'] p")];
    const longest = paragraphs.sort((a, b) => b.textContent!.length - a.textContent!.length)[0]!;
    const range = document.createRange();
    range.selectNodeContents(longest);
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    return {
      headerLeft: header.left - innerLeft,
      headerRight: innerRight - header.right,
      readerLeft: reader.left - innerLeft,
      readerRight: innerRight - reader.right,
      overflow: root.scrollWidth - root.clientWidth,
      charsPerLine: longest.textContent!.length / Math.max(1, lines),
    };
  });
}

function assertGeometry(g: PageGeometry, label: string) {
  expect(Math.abs(g.headerLeft - g.headerRight), `${label}: header insets equal`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(g.readerLeft - g.readerRight), `${label}: reader insets equal`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(g.readerLeft - g.headerLeft), `${label}: header and reader share a column`).toBeLessThanOrEqual(0.5);
  expect(g.readerLeft % 4, `${label}: inset on the 4pt grid`).toBeLessThanOrEqual(0.5);
  expect(g.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect(g.charsPerLine, `${label}: readable line length`).toBeLessThanOrEqual(80);
}

for (const width of [320, 393, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`/terms keeps one symmetric reading column at ${width}px ${theme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, "/terms", width, theme);
      assertGeometry(await geometry(page), `${width}px ${theme}`);
      await page.addStyleTag({ content: "[data-legal-document] *{letter-spacing:0.03em}" });
      assertGeometry(await geometry(page), `${width}px ${theme} widened`);
    });
  }
}

test("the old Connectors address redirects into the Profile pane", async ({ request }) => {
  const response = await request.get("/one/profile/connectors?connector=gmail", { maxRedirects: 0 });
  expect([307, 308]).toContain(response.status());
  const location = new URL(response.headers().location!, "http://app.local");
  expect(location.pathname).toBe("/one");
  expect(location.searchParams.get("profile_pane")).toBe("1");
  expect(location.searchParams.get("profile_panel")).toBe("connectors");
  expect(location.searchParams.get("profile_detail")).toBe("connector:gmail");
});

test("the provider-registered connector return address is not redirected", async ({ request }) => {
  const response = await request.get("/one/profile/connectors/oauth/return", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
});
