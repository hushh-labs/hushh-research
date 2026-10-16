import { expect, type Page } from "@playwright/test";

/** Wallet's real tab-snap probe, including the delayed-frame WebKit regression.
 * Measures visible intermediate motion, arrival time and overshoot without
 * changing production spring physics or accepting a jump to the endpoint.
 */
export async function expectWalletTabMotion(page: Page, delayInitialFrames: boolean) {
  await expect(page.getByRole("tabpanel", { name: "Cards", exact: true })).toBeVisible();
  const add = page.getByRole("tab", { name: "Add", exact: true });
  // Reproduce the delayed animation startup observed in WebKit CI. Keep
  // the real spring and arrival budget; a delayed frame must not add a
  // second long settling tail. Phone coverage retains normal frame timing.
  if (delayInitialFrames) await add.evaluate((tab) => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, { timer: number; frame?: number }>();
    let nextId = -1;
    let holdUntil = 0;
    tab.addEventListener("click", () => { holdUntil = performance.now() + 150; }, { capture: true, once: true });
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
  });
  await add.evaluate((tab) => {
    const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
    const viewport = panel.closest('[data-swipe-views-root="true"]')!;
    const state = window as unknown as { __walletTabMotion: Promise<{ time: number; offset: number }[]> };
    state.__walletTabMotion = new Promise((resolve) => {
      tab.addEventListener("click", () => {
        const started = performance.now();
        const frames: { time: number; offset: number }[] = [];
        const sample = () => {
          const time = performance.now() - started;
          frames.push({ time, offset: panel.getBoundingClientRect().x - viewport.getBoundingClientRect().x });
          if (time < 800) requestAnimationFrame(sample);
          else resolve(frames);
        };
        requestAnimationFrame(sample);
      }, { once: true });
    });
  });
  await add.click();
  const frames = await page.evaluate(() => (window as unknown as { __walletTabMotion: Promise<{ time: number; offset: number }[]> }).__walletTabMotion);
  const rendering = await add.evaluate(tab => {
    const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
    const viewport = panel.closest('[data-swipe-views-root="true"]')!;
    return { selected: tab.getAttribute("aria-selected"), visibility: document.visibilityState,
      viewportWidth: viewport.getBoundingClientRect().width,
      transform: getComputedStyle(panel.parentElement!).transform };
  });
  const diagnostics = JSON.stringify({ ...rendering, frameCount: frames.length,
    maxFrameGap: Math.max(...frames.map((frame, index) => frame.time - (frames[index - 1]?.time ?? 0))),
    first: frames.slice(0, 3), last: frames.slice(-3) });
  const arrived = frames.find((frame, index) => Math.abs(frame.offset) < 3 && frames.slice(index).every((later) => Math.abs(later.offset) < 3));
  expect(arrived, `the selected pane must arrive: ${diagnostics}`).toBeDefined();
  expect(arrived!.time, `tab presses should not wait out the drag spring: ${diagnostics}`).toBeLessThan(400);
  expect(Math.min(...frames.map((frame) => frame.offset)), `the pane must not overshoot its snap: ${diagnostics}`).toBeGreaterThanOrEqual(-3);
  expect(frames.some(frame => frame.offset > 3 && frame.offset < rendering.viewportWidth - 3), `tab selection must animate rather than jump: ${diagnostics}`).toBe(true);
}
