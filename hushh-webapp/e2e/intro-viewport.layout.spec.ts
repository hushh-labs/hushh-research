import { expect, test } from "@playwright/test";

// Exercise the actual public entry route, including its scroll-root ancestors.
const viewports = [
  { width: 402, height: 874, top: 62, bottom: 34 },
  { width: 393, height: 852, top: 59, bottom: 34 },
  { width: 375, height: 667, top: 20, bottom: 0 },
  { width: 320, height: 568, top: 20, bottom: 0 },
  { width: 390, height: 664, top: 0, bottom: 0 }, // browser bars expanded
  { width: 852, height: 393, top: 0, bottom: 21 },
  { width: 1024, height: 768, top: 24, bottom: 20 },
  { width: 768, height: 874, top: 24, bottom: 34 },
  { width: 1440, height: 900, top: 0, bottom: 0 },
];

for (const dark of [false, true]) {
  for (const viewport of viewports) {
    test(`welcome and four stories ${dark ? "dark" : "light"} ${viewport.width}x${viewport.height} fit`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((theme) => localStorage.setItem("theme", theme), dark ? "dark" : "light");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/?invite=one");
      const preview = page.getByTestId("guest-preview");
      // The real route can compile its public-entry chunk on a cold dev server.
      await expect(preview).toBeVisible({ timeout: 30000 });
      await page.addStyleTag({ content: `:root { --app-safe-area-top-effective: ${viewport.top}px !important; --app-safe-area-bottom-effective: ${viewport.bottom}px !important; }` });
      await page.evaluate(() => document.fonts.ready);
      const storyTitles = [
        "Big plans.Less busywork.",
        "Find answers.Not more tabs.",
        "Your people.Right here.",
        "Your information.Your call.",
      ];
      for (let step = 1; step <= 5; step++) {
        await expect(preview).toHaveAttribute("data-preview-step", String(step));
        if (step === 1) {
          const heading = preview.getByRole("heading", { name: "Your private AI agent for everyday life." });
          await expect(heading).toBeVisible();
          await expect(heading).toHaveCSS("font-family", /Plus Jakarta Sans/);
          await expect(heading).toHaveCSS("font-weight", "600");
          if (viewport.width === 393 || viewport.width === 1440) {
            const size = await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
            expect(size).toBeCloseTo(viewport.width === 393 ? 30 : 48, 0);
          }
        }
        const story = preview.locator(".ao-slide");
        const cta = step === 1
          ? preview.getByRole("button", { name: "Create your One", exact: true })
          : story.getByRole("button", { name: step === 5 ? "Get started" : "Next", exact: true });
        if (step > 1) {
          await expect(story.locator("[data-intro-v2-title]")).toHaveText(storyTitles[step - 2]);
          await expect(story).toBeVisible();
          await expect(preview.locator("[data-intro-v2-card]:visible")).toHaveCount(1);
        }
        const result = await preview.evaluate((element) => {
          const root = document.querySelector<HTMLElement>("[data-app-scroll-root]")!;
          return { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight, top: element.getBoundingClientRect().top };
        });
        expect(result.x).toBeLessThanOrEqual(1);
        if (viewport.width <= 430 && viewport.height >= 664) expect(result.y).toBeLessThanOrEqual(1);
        await expect(cta).toBeVisible();
        await cta.scrollIntoViewIfNeeded();
        await expect(cta).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`intro-${step}.png`) });
        if (step < 5) await cta.click();
      }
    });
  }
}

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 320, height: 568 }, { width: 400, height: 788 }, { width: 402, height: 874 }, { width: 800, height: 700 }, { width: 1440, height: 900 }]) {
    test(`sign-in ${theme} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      await page.goto("/login");
      const screen = page.getByTestId("auth-step-primary");
      await expect(screen).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(screen).toHaveCSS("background-color", "rgb(255, 255, 255)");

      const illustration = screen.locator("[data-auth-illustration]");
      const mascot = illustration.locator("[data-welcome-mascot]");
      await expect(illustration).toBeVisible();
      await expect(mascot).toBeVisible();
      await expect(mascot).toHaveAttribute("src", /one-mascot\.png/);
      await expect.poll(() => mascot.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

      const form = screen.locator("[data-auth-content-block]");
      const artBox = await illustration.boundingBox();
      const formBox = await form.boundingBox();
      expect(artBox && formBox).toBeTruthy();
      if (!artBox || !formBox) return;
      if (viewport.width >= 800) {
        expect(artBox.x + artBox.width).toBeLessThanOrEqual(formBox.x + 8);
        expect(artBox.width).toBeLessThanOrEqual(500);
        expect(formBox.width).toBeLessThanOrEqual(430);
      } else {
        expect(artBox.y + artBox.height).toBeLessThanOrEqual(formBox.y + 8);
        expect(artBox.x).toBeGreaterThanOrEqual(-1);
        expect(artBox.x + artBox.width).toBeLessThanOrEqual(viewport.width + 1);
      }

      const heading = screen.getByRole("heading", { name: "Welcome to One" });
      await expect(heading).toHaveCSS("font-size", "30px");
      await expect(heading).toHaveCSS("font-weight", "600");
      await expect(heading).toHaveCSS("line-height", "36px");
      await expect(heading).toHaveCSS("font-family", /Plus Jakarta Sans/);
      for (const provider of ["Apple", "Google"]) {
        const button = screen.getByRole("button", { name: `Continue with ${provider}`, exact: true });
        await expect(button).toBeVisible();
        await expect(button).toHaveCSS("border-top-width", "1px");
        await expect(button).toHaveCSS("border-top-style", "solid");
        await expect(button).toHaveCSS("font-family", /Plus Jakarta Sans/);
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(52);
      }
      const footer = screen.locator("[data-auth-supporting-content]");
      await expect(footer.locator("p")).toHaveCSS("font-size", "13px");
      await expect(footer.locator("p")).toHaveCSS("line-height", "18px");
      await expect(footer.locator("p")).toHaveCSS("font-family", /Plus Jakarta Sans/);
      if (viewport.width === 400) {
        await expect(footer).toBeInViewport();
        expect(await screen.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      }
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport();
      if (viewport.width === 320) {
        expect(await screen.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("sign-in.png") });
    });
  }
}

test("sign-in keeps provider choices without redundant account toggles", async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.goto("/login");
  const screen = page.getByTestId("auth-step-primary");
  await expect(screen.getByRole("button", { name: "Already have an account? Sign in" })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "New to One? Get started" })).toHaveCount(0);
  await expect(screen.getByRole("checkbox", { name: "Find people I know" })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Go back" })).toBeVisible();
});

// Terms and Privacy on sign-in are plain links to the full pages, in the same
// tab, never an in-app popup. Back returns to sign-in.
test("sign-in Terms and Privacy open their full pages, not a popup", async ({ page }) => {
  await page.setViewportSize({ width: 402, height: 874 });
  await page.goto("/login");
  const footer = page.getByTestId("auth-step-primary").locator("[data-auth-supporting-content]");

  const terms = footer.getByRole("link", { name: "Terms", exact: true });
  const privacy = footer.getByRole("link", { name: "Privacy Policy", exact: true });
  await expect(terms).toHaveAttribute("href", "/terms");
  await expect(privacy).toHaveAttribute("href", "/privacy");
  await expect(terms).not.toHaveAttribute("target", /.+/);
  await expect(terms).toHaveCSS("font-size", "13px");
  await expect(footer.getByRole("button")).toHaveCount(0);

  await terms.click();
  await expect(page).toHaveURL(/\/terms\/?$/);
  await expect(page.getByTestId("legal-terms-page")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/login\/?$/);
  await page
    .getByTestId("auth-step-primary")
    .locator("[data-auth-supporting-content]")
    .getByRole("link", { name: "Privacy Policy", exact: true })
    .click();
  await expect(page).toHaveURL(/\/privacy\/?$/);
  await expect(page.getByTestId("legal-privacy-page")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
