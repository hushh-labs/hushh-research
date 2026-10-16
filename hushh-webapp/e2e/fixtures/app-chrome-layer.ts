import { expect, type Page } from "@playwright/test";

/** Match routed content's stacking context and its fixed chrome sibling.
 * The real drawer must portal above both without shifting either surface. */
export async function mountAppChrome(page: Page, barHeight: number) {
  // createRoot commits asynchronously after the fixture script is inserted.
  await page.locator("main").waitFor({ state: "attached" });
  await page.evaluate((height) => {
    document.documentElement.style.setProperty("--app-bottom-shell-height", `${height}px`);
    const main = document.querySelector("main")!;
    main.style.position = "relative";
    main.style.zIndex = "10";
    const bar = document.createElement("nav");
    bar.setAttribute("data-fixture-bottom-bar", "");
    bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${height}px;z-index:var(--z-chrome);background:var(--background)`;
    document.body.append(bar);
  }, barHeight);
}

/** A viewport resize is not part of the subsequent authored tap/drag. */
export async function awaitClosedHistoryGeometry(page: Page) {
  await expect.poll(() => page.locator("[data-agent-history-drawer]").evaluate(panel => {
    const style = getComputedStyle(panel);
    return panel.getBoundingClientRect().x +
      (panel as HTMLElement).offsetWidth + parseFloat(style.getPropertyValue("--agent-history-shadow-clearance"));
  })).toBeCloseTo(0, 0);
}
