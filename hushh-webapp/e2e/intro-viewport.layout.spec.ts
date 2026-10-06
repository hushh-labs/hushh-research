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
    test(`four-screen intro ${dark ? "dark" : "light"} ${viewport.width}x${viewport.height} fits`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((theme) => localStorage.setItem("theme", theme), dark ? "dark" : "light");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/?invite=one");
      const preview = page.getByTestId("guest-preview");
      // The real route can compile its public-entry chunk on a cold dev server.
      await expect(preview).toBeVisible({ timeout: 30000 });
      await page.addStyleTag({ content: `:root { --app-safe-area-top-effective: ${viewport.top}px !important; --app-safe-area-bottom-effective: ${viewport.bottom}px !important; }` });
      await page.evaluate(() => document.fonts.ready);
      for (let step = 1; step <= 4; step++) {
        await expect(preview).toHaveAttribute("data-preview-step", String(step));
        const cta = preview.getByRole("button", { name: step === 1 ? "Create your One" : step === 2 ? "Meet your agents" : step === 3 ? "See what’s next" : "Create your One", exact: true });
        const result = await preview.evaluate((element) => {
          const root = document.querySelector<HTMLElement>("[data-app-scroll-root]")!;
          return { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight, top: element.getBoundingClientRect().top };
        });
        expect(result.x).toBeLessThanOrEqual(1);
        if (viewport.height >= 568) expect(result.y).toBeLessThanOrEqual(1);
        await expect(cta).toBeVisible();
        await cta.scrollIntoViewIfNeeded();
        await expect(cta).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`intro-${step}.png`) });
        if (step < 4) await cta.click();
      }
    });
  }
}

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 320, height: 568 }, { width: 402, height: 874 }, { width: 1440, height: 900 }]) {
    test(`sign-in ${theme} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      await page.goto("/login");
      const screen = page.getByTestId("auth-step-primary");
      await expect(screen).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const heading = screen.getByRole("heading", { name: "Welcome to One" });
      await expect(heading).toHaveCSS("font-size", "30px");
      await expect(heading).toHaveCSS("font-weight", "600");
      await expect(heading).toHaveCSS("line-height", "36px");
      for (const provider of ["Apple", "Google"]) {
        const button = screen.getByRole("button", { name: `Continue with ${provider}`, exact: true });
        await expect(button).toBeVisible();
        await expect(button).toHaveCSS("border-top-width", "1px");
        await expect(button).toHaveCSS("border-top-style", "solid");
      }
      const footer = screen.locator("[data-auth-supporting-content]");
      await expect(footer.locator("p")).toHaveCSS("font-size", "13px");
      await expect(footer.locator("p")).toHaveCSS("line-height", "18px");
      await expect(footer).toHaveCSS("text-align", "center");
      await expect(footer.locator("img")).toHaveCount(0);
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("sign-in.png") });
    });
  }
}

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
