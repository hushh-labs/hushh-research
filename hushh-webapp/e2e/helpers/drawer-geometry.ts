import { expect, type Locator, type Page } from "@playwright/test";

export async function expectHistoryClosed(page: Page) {
  const panel = page.locator("[data-agent-history-drawer]");
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(panel).toHaveAttribute("inert", "");
  await expect(panel).toHaveCSS("visibility", "hidden");
  const pose = await panel.evaluate(element => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate,
      clearance: style.getPropertyValue("--agent-history-shadow-clearance"),
      inset: style.getPropertyValue("--app-side-pane-left-inset"),
    };
  });
  // An authored closed panel clears its shadow, independently of its inset.
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().right), { message: JSON.stringify(pose) }).toBeCloseTo(-48, 0);
  const scrim = page.locator("[data-agent-history-scrim]");
  await expect(scrim).toHaveCSS("visibility", "hidden");
  await expect(scrim).toHaveCSS("pointer-events", "none");
}

export async function expectHistoryHeaderSlot(panel: Locator, width: number) {
  const gutter = width >= 1024 ? 24 : width >= 640 ? 20 : 16;
  const header = panel.locator('[data-agent-history-header-layout="aligned"]');
  expect(await header.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))).toBe(gutter);
  const border = await panel.evaluate(element => parseFloat(getComputedStyle(element).borderLeftWidth));
  const close = panel.getByRole("button", { name: "Close chat history", exact: true });
  expect((await close.boundingBox())!.x - (await panel.boundingBox())!.x).toBeCloseTo(gutter + border, 0);
}

export async function expectPaneRestingAtFrame(page: Page, pane: Locator) {
  const inset = (await profileFrame(page)).x;
  await expect.poll(() => pane.evaluate((element, x) => Math.abs(element.getBoundingClientRect().left - x), inset)).toBeLessThanOrEqual(1);
}

export async function profileFrame(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const reference = document.createElement("div");
    reference.className = "profile-pane-sheet";
    reference.dataset.slot = "sheet-content";
    reference.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
    document.body.append(reference);
    const bounds = reference.getBoundingClientRect();
    const result = { x: innerWidth - bounds.right, y: bounds.y,
      width: bounds.width, height: bounds.height,
      radius: getComputedStyle(reference).borderTopLeftRadius };
    reference.remove();
    return result;
  });
}

/**
 * The real app, reduced to the two things that decide this drawer's stacking:
 * the routed content (the chat workspace, header included) sits in a
 * `relative z-10` wrapper (app/providers.tsx), and the bottom bar is a fixed
 * sibling on the chrome tier (components/app-ui/app-bottom-shell.tsx, z-118).
 * A drawer left inside the workspace can never rise above that bar.
 */
export async function mountAppChrome(page: import("@playwright/test").Page, barHeight: number) {
  await page.locator("main [data-gesture-body]").waitFor({ state: "attached" });
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

/** What a finger at (x, y) would land on: the scrim, the panel, or chrome. */
export function hitAt(page: import("@playwright/test").Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px, py);
    if (!element) return "none";
    if (element.closest("[data-agent-history-scrim]")) return "scrim";
    if (element.closest("[data-agent-history-drawer]")) return "panel";
    if (element.closest("[data-fixture-bottom-bar]")) return "bottom-bar";
    if (element.closest("header.agent-chat-header") || element.closest("button")?.textContent === "Open drawer") return "header";
    return element.tagName.toLowerCase();
  }, [x, y] as const);
}

/** Compare the drawer scrim against resolved product tokens. */
export function readDrawerScrim(scrim: Locator) {
  return scrim.evaluate((element) => {
        const style = getComputedStyle(element);
        // Resolve the canonical tokens through a probe so the comparison is
        // computed-to-computed, whatever the pointer media query picked.
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--app-scrim-color)";
        probe.style.backdropFilter = "var(--app-scrim-filter)";
        document.body.appendChild(probe);
        const canonical = getComputedStyle(probe);
        const result = {
          background: style.backgroundColor,
          filter: style.backdropFilter,
          canonicalBackground: canonical.backgroundColor,
          canonicalFilter: canonical.backdropFilter,
          opacity: style.opacity,
          visibility: style.visibility,
          pointer: style.pointerEvents,
        };
        probe.remove();
        return result;
      });
}
