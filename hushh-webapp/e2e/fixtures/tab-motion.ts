import type { Locator } from "@playwright/test";

type Frame = { time: number; offset: number };

/** Observe the shipping pager, including a bounded delay before its first frame. */
export async function measureTabSelection(tab: Locator, initialFrameDelayMs = 0, advanceFrames?: () => Promise<void>) {
  await tab.evaluate((element, delayMs) => {
    if (delayMs > 0) {
      const request = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map<number, { timer: number; frame?: number }>();
      let nextId = -1;
      let holdUntil = 0;
      element.addEventListener("click", () => { holdUntil = performance.now() + delayMs; }, { capture: true, once: true });
      window.requestAnimationFrame = (callback) => {
        const delay = holdUntil - performance.now();
        if (delay <= 0) return request(callback);
        const id = nextId--;
        const entry = { timer: window.setTimeout(() => {
          entry.frame = request(time => { pending.delete(id); callback(time); });
        }, delay), frame: undefined as number | undefined };
        pending.set(id, entry);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const entry = pending.get(id);
        if (!entry) { cancel(id); return; }
        clearTimeout(entry.timer);
        if (entry.frame !== undefined) cancel(entry.frame);
        pending.delete(id);
      };
    }
    const panel = document.getElementById(element.getAttribute("aria-controls")!)!;
    const viewport = panel.closest('[data-swipe-views-root="true"]')!;
    const state = window as unknown as { __walletTabMotion: Promise<Frame[]> };
    state.__walletTabMotion = new Promise((resolve) => {
      element.addEventListener("click", () => {
        const started = performance.now();
        const frames: Frame[] = [];
        const sample = () => {
          const time = performance.now() - started;
          frames.push({ time, offset: panel.getBoundingClientRect().x - viewport.getBoundingClientRect().x });
          if (time < 800) requestAnimationFrame(sample);
          else resolve(frames);
        };
        requestAnimationFrame(sample);
      }, { once: true });
    });
  }, initialFrameDelayMs);
  await tab.click();
  await advanceFrames?.();
  const frames = await tab.page().evaluate(() => (window as unknown as { __walletTabMotion: Promise<Frame[]> }).__walletTabMotion);
  const rendering = await tab.evaluate(element => {
    const panel = document.getElementById(element.getAttribute("aria-controls")!)!;
    const viewport = panel.closest('[data-swipe-views-root="true"]')!;
    return { selected: element.getAttribute("aria-selected"), visibility: document.visibilityState,
      viewportWidth: viewport.getBoundingClientRect().width,
      transform: getComputedStyle(panel.parentElement!).transform };
  });
  return { frames, rendering };
}
