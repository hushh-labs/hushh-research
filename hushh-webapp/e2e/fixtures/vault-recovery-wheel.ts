import { expect, type Locator, type Page } from "@playwright/test";

/** Prove user scrolling can reveal recovery, with a genuinely clipped negative control. */
export async function verifyRecoveryWheelAccess(page: Page, content: Locator, recoveryGeometry: () => Promise<{ contained: boolean }>) {
  // Negative control: programmatic reveal would pass overflow:hidden.
  // A real wheel inside the scrollport must not pass that broken state.
  const originalScrollStyle = await content.evaluate((node) => {
    const footer = [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Recovery key")!;
    const original = { maxHeight: node.style.maxHeight, overflowY: node.style.overflowY };
    // Padding alone may overflow with all controls visible. Clip an actual
    // target so the negative proves that hidden scrolling blocks recovery.
    node.style.maxHeight = `${footer.getBoundingClientRect().top - node.getBoundingClientRect().top + footer.getBoundingClientRect().height / 2}px`;
    node.style.overflowY = "hidden";
    node.scrollTop = 0;
    return original;
  });
  const pointInsideScrollport = async () => {
    const point = await content.evaluate(node => {
      const r = node.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = Math.max(r.top, 0) + (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / 2;
      return { x, y, containsHit: node.contains(document.elementFromPoint(x, y)) };
    });
    expect(point.containsHit).toBe(true);
    await page.mouse.move(point.x, point.y);
  };
  try {
    await expect.poll(async () => (await recoveryGeometry()).contained).toBe(false);
    await pointInsideScrollport();
    await page.mouse.wheel(0, 1000);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
    expect((await recoveryGeometry()).contained).toBe(false);
    await content.evaluate((node) => { node.style.overflowY = "auto"; });
    // Synchronize the fixture's deliberate overflow mutation before the
    // next wheel. WebKit failed without this paint boundary.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await pointInsideScrollport();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect.poll(async () => (await recoveryGeometry()).contained).toBe(true);
  } finally {
    await content.evaluate((node, original) => {
      node.style.maxHeight = original.maxHeight; node.style.overflowY = original.overflowY;
    }, originalScrollStyle);
  }
}
