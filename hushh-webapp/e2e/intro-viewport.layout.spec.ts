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
    test(`intro ${dark ? "dark" : "light"} ${viewport.width}x${viewport.height} fits`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((theme) => localStorage.setItem("theme", theme), dark ? "dark" : "light");
      await page.goto("/");
      const screen = page.getByTestId("one-intro-screen");
      await expect(screen).toBeVisible();
      await page.addStyleTag({ content: `:root { --app-safe-area-top-effective: ${viewport.top}px !important; --app-safe-area-bottom-effective: ${viewport.bottom}px !important; }` });
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => screen.locator("img").evaluateAll(images => images.every(image => {
        const img = image as HTMLImageElement;
        return getComputedStyle(img).display === "none" || (img.complete && img.naturalWidth > 0);
      }))).toBe(true);
      const result = await screen.evaluate((element) => {
        const rect = (e: Element) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const button = element.querySelector("button")!;
        const privacy = [...element.querySelectorAll("span")].find(e => e.textContent === "You choose what to share.")!;
        const lines = [...privacy.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => {
          const range = document.createRange();
          range.selectNodeContents(n);
          return [...range.getClientRects()].filter(r => r.width > 0).length;
        });
        const ancestors = [];
        for (let e: HTMLElement | null = element; e; e = e.parentElement) {
          ancestors.push({ tag: e.tagName, x: e.scrollWidth - e.clientWidth, y: e.scrollHeight - e.clientHeight });
        }
        const visibleImages = [...element.querySelectorAll("img")].filter(e => getComputedStyle(e).display !== "none");
        const privacyRow = privacy.parentElement!;
        const subtitle = [...element.querySelectorAll("p")].find(e => e.textContent === "Your private network of AI agents")!;
        const privacyStyle = getComputedStyle(privacy);
        const buttonStyle = getComputedStyle(button);
        return { subtitle: rect(subtitle), privacyRow: rect(privacyRow), privacyFont: privacyStyle.fontSize, privacyLine: privacyStyle.lineHeight, buttonFont: buttonStyle.fontSize, buttonWeight: buttonStyle.fontWeight, button: rect(button), privacy: rect(privacy), lines, ancestors, images: visibleImages.map(e => ({ alt: e.alt, loaded: e.complete && e.naturalWidth > 0, ...rect(e) })) };
      });
      for (const ancestor of result.ancestors) {
        expect(ancestor.x, `${ancestor.tag} horizontal overflow`).toBeLessThanOrEqual(1);
        if (viewport.height >= 667) expect(ancestor.y, `${ancestor.tag} vertical overflow`).toBeLessThanOrEqual(1);
      }
      expect(result.lines).toEqual([1]);
      expect(result.privacyFont).toBe("13px");
      expect(result.privacyLine).toBe("20px");
      expect(result.buttonFont).toBe("17px");
      expect(result.buttonWeight).toBe("600");
      expect(result.privacyRow.y - result.subtitle.bottom).toBeCloseTo(48, 0);
      expect(result.button.y - result.privacyRow.bottom).toBeCloseTo(10, 0);
      expect(result.button.height).toBeCloseTo(50, 0);
      expect(result.button.width).toBeCloseTo(Math.min(viewport.width, 440) - 48, 0);
      expect(result.button.x).toBeGreaterThanOrEqual(0);
      expect(result.button.right).toBeLessThanOrEqual(viewport.width);
      if (viewport.height >= 667) expect(result.button.bottom).toBeLessThanOrEqual(viewport.height - viewport.bottom);
      expect(result.button.y - result.privacy.bottom).toBeCloseTo(10, 0);
      for (const image of result.images) {
        expect(image.loaded).toBe(true);
        // Decorative exports include intentionally oversized transparent/cropped
        // canvases. Preserve those authored crops; bound the actual logos here.
        if (!image.alt) continue;
        expect(image.x).toBeGreaterThanOrEqual(0);
        expect(image.right).toBeLessThanOrEqual(viewport.width);
        expect(image.y).toBeGreaterThanOrEqual(viewport.top);
        expect(image.bottom).toBeLessThanOrEqual(viewport.height - viewport.bottom);
      }
      const links = screen.getByRole("navigation", { name: "Explore Hussh" });
      if (viewport.width >= 640 && viewport.height >= 860) {
        const bounds = (await links.boundingBox())!;
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - viewport.bottom + 1);
      }
      // Very short/landscape views scroll instead of shrinking controls.
      await screen.getByRole("button", { name: "Claim your One" }).scrollIntoViewIfNeeded();
      await expect(screen.getByRole("button", { name: "Claim your One" })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("intro.png") });
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
