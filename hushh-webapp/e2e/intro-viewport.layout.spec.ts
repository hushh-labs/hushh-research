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
        const privacy = [...element.querySelectorAll("span")].find(e => e.textContent === "You have full control over your data.Your data. Your rules.")!;
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
        return { button: rect(button), privacy: rect(privacy), lines, ancestors, images: visibleImages.map(e => ({ alt: e.alt, loaded: e.complete && e.naturalWidth > 0, ...rect(e) })) };
      });
      for (const ancestor of result.ancestors) {
        expect(ancestor.x, `${ancestor.tag} horizontal overflow`).toBeLessThanOrEqual(1);
        expect(ancestor.y, `${ancestor.tag} vertical overflow`).toBeLessThanOrEqual(1);
      }
      expect(result.lines).toEqual([1, 1]);
      expect(result.button.x).toBeGreaterThanOrEqual(0);
      expect(result.button.right).toBeLessThanOrEqual(viewport.width);
      expect(result.button.bottom).toBeLessThanOrEqual(viewport.height - viewport.bottom);
      expect(result.privacy.bottom).toBeLessThan(result.button.y);
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
      // The approved native frame must not move or shrink.
      if (viewport.width === 402) {
        expect(result.button.x).toBeCloseTo(36, 0);
        expect(result.button.y).toBeCloseTo(759, 0);
        expect(result.button.width).toBeCloseTo(330, 0);
        expect(result.button.height).toBeCloseTo(52, 0);
      }
      await page.mouse.wheel(0, 500);
      expect(await screen.evaluate(e => e.scrollTop)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("intro.png") });
    });
  }
}
