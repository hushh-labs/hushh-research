import { expect, test, type Page, type Locator } from "@playwright/test";
import type { MountMessages } from "./messages-presentation-cases";

const sizes = [
  [320, 844], [350, 844], [360, 844], [374, 844], [379, 844],
  [390, 844], [430, 844], [479, 844], [620, 844], [767, 844],
  [768, 844], [1023, 844], [1024, 844], [1279, 844], [1280, 844], [1440, 844],
  [844, 499], [844, 500], [1023, 499], [1024, 499],
] as const;

async function check(header: Locator, width: number) {
  const bounds = await header.evaluate(node => {
    const area = node.getBoundingClientRect();
    const controls = [...node.querySelectorAll("button,a")].filter(control => getComputedStyle(control).display !== "none")
      .map(control => { const box = control.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }; });
    return { area: { x: area.x, y: area.y, right: area.right, bottom: area.bottom }, controls,
      pageWidth: document.documentElement.scrollWidth };
  });
  expect(bounds.pageWidth, `${width}px page overflow`).toBeLessThanOrEqual(width + 1);
  for (const control of bounds.controls) {
    expect(control.x, `${width}px header left`).toBeGreaterThanOrEqual(bounds.area.x - 1);
    expect(control.right, `${width}px header right`).toBeLessThanOrEqual(bounds.area.right + 1);
    expect(control.bottom, `${width}px header bottom`).toBeLessThanOrEqual(bounds.area.bottom + 1);
  }
}

async function openThread(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const picker = page.getByRole("dialog", { name: "New chat" });
  await picker.getByRole("searchbox", { name: "Search connections" }).fill("Maya");
  await picker.getByRole("button", { name: "Message Maya Rao", exact: true }).click();
}

// Keep every viewport and geometry assertion; each pane has its own original
// deadline rather than charging sixty viewport transitions to one test.
export function registerMessagesHeaderBreakpointCases(mount: MountMessages): void {
  for (const pane of ["Conversations", "Thread", "Circles"] as const) {
    test(`Messages header actions stay inside their pane at breakpoint edges: ${pane}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mount(page, false, false, true);
      if (pane !== "Conversations") await openThread(page);
      if (pane === "Circles") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Back to messages" }).click();
        await page.getByRole("tab", { name: "Circles 3" }).click();
      }
      const header = pane === "Thread" ? page.getByRole("main").locator("header").first()
        : page.getByRole("complementary", { name: pane }).locator("header");
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await check(header, width);
      }
    });
  }
}
