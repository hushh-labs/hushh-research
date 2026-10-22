import { expect, type Locator, type Page } from "@playwright/test";

/** Release gesture overrides and settle responsive CSS before timing new input. */
export async function expectPaneMotionReleased(pane: Locator) {
  await expect.poll(() => pane.evaluate(element =>
    ["transition", "transform", "translate", "visibility", "will-change"]
      .every(property => !(element as HTMLElement).style.getPropertyValue(property)),
  )).toBe(true);
  await expect.poll(() => pane.evaluate(element => {
    const panel = element as HTMLElement;
    const style = getComputedStyle(panel);
    const clearance = Number.parseFloat(style.getPropertyValue("--agent-history-shadow-clearance")) || 0;
    const restingX = panel.dataset.state === "closed" ? -panel.offsetWidth - clearance : panel.offsetLeft;
    const moving = panel.getAnimations().some(animation =>
      animation.playState !== "finished" && animation.playState !== "idle" &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime));
    return !moving && Math.abs(panel.getBoundingClientRect().x - restingX) <= 1;
  })).toBe(true);
}

type HistoryMotion = {
  frames: { elapsed: number; x: number; source: "raf" | "timer" }[];
  transitions: { type: string; property: string; elapsed: number }[];
  width: number;
  restingX: number;
  before: number[];
  after: number[];
  shadowClearance: number;
  rendering: { visibility: string; state: string | undefined; translate: string; delay: string };
};

type MotionWindow = Window & { historyMotion?: { result?: HistoryMotion; stop: () => void } };

/** Collect real CSS geometry while Playwright delivers native input outside evaluation. */
export async function sampleHistoryMotion(page: Page, action: "open" | "close") {
  await page.evaluate(action => {
    const panel = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
    const main = document.querySelector("main")!;
    const nav = document.querySelector("[data-fixture-bottom-bar]")!;
    const before = [main.getBoundingClientRect().x, nav.getBoundingClientRect().y];
    const width = panel.offsetWidth;
    const frames: HistoryMotion["frames"] = [];
    const transitions: HistoryMotion["transitions"] = [];
    let start: number | undefined;
    let frameId = 0;
    let timerId = 0;
    let finishId = 0;
    const observeTransition = (event: TransitionEvent) => {
      if (start !== undefined && event.target === panel && ["translate", "transform", "visibility"].includes(event.propertyName))
        transitions.push({ type: event.type, property: event.propertyName, elapsed: performance.now() - start });
    };
    const sample = (source: "raf" | "timer") => {
      if (start !== undefined) frames.push({ elapsed: performance.now() - start, x: panel.getBoundingClientRect().x, source });
    };
    const onFrame = () => { sample("raf"); frameId = requestAnimationFrame(onFrame); };
    const stop = () => {
      cancelAnimationFrame(frameId);
      clearInterval(timerId);
      clearTimeout(finishId);
      document.removeEventListener("click", onInput, true);
      document.removeEventListener("keydown", onInput, true);
      panel.removeEventListener("transitionrun", observeTransition);
      panel.removeEventListener("transitionstart", observeTransition);
    };
    const onInput = (event: Event) => {
      if (start !== undefined || !event.isTrusted) return;
      if (action === "open" ? !(event.target as Element).closest("button")?.textContent?.includes("Open drawer")
        : !(event instanceof KeyboardEvent && event.key === "Escape")) return;
      start = performance.now();
      sample("timer");
      finishId = window.setTimeout(() => {
        sample("timer");
        const style = getComputedStyle(panel);
        (window as MotionWindow).historyMotion!.result = { frames, transitions, width, restingX: panel.offsetLeft, before,
          after: [main.getBoundingClientRect().x, nav.getBoundingClientRect().y],
          shadowClearance: Number.parseFloat(style.getPropertyValue("--agent-history-shadow-clearance")) || 0,
          rendering: { visibility: document.visibilityState, state: panel.dataset.state, translate: style.translate, delay: style.transitionDelay } };
        stop();
      }, action === "open" ? 360 : 260);
    };
    document.addEventListener("click", onInput, true);
    document.addEventListener("keydown", onInput, true);
    panel.addEventListener("transitionrun", observeTransition);
    panel.addEventListener("transitionstart", observeTransition);
    frameId = requestAnimationFrame(onFrame);
    timerId = window.setInterval(() => sample("timer"), 8);
    (window as MotionWindow).historyMotion = { stop };
  }, action);
  try {
    if (action === "open") await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    else await page.keyboard.press("Escape");
    // Keep browser evaluation turns short while its native compositor runs.
    await page.waitForFunction(() => Boolean((window as MotionWindow).historyMotion?.result), undefined, { polling: 16 });
    return await page.evaluate(() => (window as MotionWindow).historyMotion!.result!);
  } finally {
    await page.evaluate(() => { (window as MotionWindow).historyMotion?.stop(); delete (window as MotionWindow).historyMotion; });
  }
}

export async function expectPaneRestingAtFrame(page: Page, pane: Locator, leftSafeInset = 0) {
  const inset = Math.max((await profileFrame(page)).x, leftSafeInset);
  await expect.poll(() => pane.evaluate((element, x) => Math.abs(element.getBoundingClientRect().left - x), inset)).toBeLessThanOrEqual(1);
}

export async function profileFrame(page: import("@playwright/test").Page, safeSidePane = false) {
  return page.evaluate((safeSidePane) => {
    const reference = document.createElement("div");
    reference.className = safeSidePane ? "" : "profile-pane-sheet";
    if (safeSidePane) reference.dataset.appSidePane = "";
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
  }, safeSidePane);
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

/** A viewport resize is not part of the subsequent authored tap/drag. */
export async function awaitClosedHistoryGeometry(page: Page) {
  await expect.poll(() => page.locator("[data-agent-history-drawer]").evaluate(panel => {
    const style = getComputedStyle(panel);
    return panel.getBoundingClientRect().x +
      (panel as HTMLElement).offsetWidth + parseFloat(style.getPropertyValue("--agent-history-shadow-clearance"));
  })).toBeCloseTo(0, 0);
}
