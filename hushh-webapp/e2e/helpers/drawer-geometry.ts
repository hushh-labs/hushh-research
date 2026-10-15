import { expect, type Locator, type Page } from "@playwright/test";

/** Gesture settlement must release its inline overrides before CSS motion is sampled. */
export async function expectPaneMotionReleased(pane: Locator) {
  await expect.poll(() => pane.evaluate(element =>
    ["transition", "transform", "translate", "visibility", "will-change"]
      .every(property => !(element as HTMLElement).style.getPropertyValue(property)),
  )).toBe(true);
  await pane.evaluate(async element => {
    element.getBoundingClientRect();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** Sample the real fixture action after a painted baseline, retaining intermediate frames. */
export async function sampleHistoryMotion(page: Page, action: "open" | "close") {
  return page.evaluate(async action => {
    const panel = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
    const main = document.querySelector("main")!;
    const nav = document.querySelector("[data-fixture-bottom-bar]")!;
    const before = [main.getBoundingClientRect().x, nav.getBoundingClientRect().y];
    const width = panel.offsetWidth;
    const frames: { elapsed: number; x: number }[] = [];
    const start = performance.now();
    const finished = new Promise<void>(resolve => {
      const sample = () => {
        const elapsed = performance.now() - start;
        frames.push({ elapsed, x: panel.getBoundingClientRect().x });
        if (elapsed < (action === "open" ? 360 : 260)) requestAnimationFrame(sample); else resolve();
      };
      requestAnimationFrame(sample);
    });
    if (action === "open") {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find(button => button.textContent === "Open drawer")!.click();
    } else {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    await finished;
    return { frames, width, restingX: panel.offsetLeft, before,
      after: [main.getBoundingClientRect().x, nav.getBoundingClientRect().y],
      shadowClearance: Number.parseFloat(getComputedStyle(panel).getPropertyValue("--agent-history-shadow-clearance")) || 0 };
  }, action);
}

export async function expectPaneRestingAtFrame(page: Page, pane: Locator, leftSafeInset = 0) {
  const inset = Math.max((await profileFrame(page)).x, leftSafeInset);
  await expect.poll(() => pane.evaluate((element, x) => Math.abs(element.getBoundingClientRect().left - x), inset)).toBeLessThanOrEqual(1);
}

export async function profileFrame(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const reference = document.createElement("div");
    reference.className = "profile-pane-sheet";
    reference.dataset.slot = "sheet-content";
    reference.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
    const card = document.createElement("div");
    const stack = document.createElement("div");
    stack.className = "profile-pane-scroll-root";
    const content = document.createElement("div");
    content.dataset.profileStackContent = "true";
    card.dataset.slot = "settings-group-shell";
    content.append(card);
    stack.append(content);
    reference.append(stack);
    document.body.append(reference);
    const bounds = reference.getBoundingClientRect();
    const style = getComputedStyle(reference);
    const result = { x: innerWidth - bounds.right, y: bounds.y,
      width: bounds.width, height: bounds.height,
      radius: style.borderTopLeftRadius,
      card: { background: getComputedStyle(card).backgroundColor,
        radius: getComputedStyle(card).borderTopLeftRadius, shadow: getComputedStyle(card).boxShadow },
      material: {
        background: style.backgroundColor, border: style.borderTopColor,
        shadow: style.boxShadow, blur: style.backdropFilter,
        webkitBlur: style.getPropertyValue("-webkit-backdrop-filter"),
      } };
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
