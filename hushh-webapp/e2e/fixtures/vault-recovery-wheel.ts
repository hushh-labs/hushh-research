import { expect, type Locator, type Page } from "@playwright/test";

/** Prove user scrolling can reveal recovery, with a genuinely clipped negative control. */
export async function verifyRecoveryWheelAccess(page: Page, content: Locator, recoveryGeometry: () => Promise<{ contained: boolean }>) {
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
  // First prove scrolling under unmodified production geometry. A cancelled
  // negative-control wheel must not contaminate this independent assertion.
  await expect(content).toHaveCSS("overflow-y", "auto");
  expect(await content.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect.poll(async () => {
    const top = await content.evaluate(node => node.scrollTop);
    if (top > 0) return top;
    await pointInsideScrollport();
    await page.mouse.wheel(0, 1000);
    return content.evaluate(node => node.scrollTop);
  }).toBeGreaterThan(0);
  await expect.poll(async () => (await recoveryGeometry()).contained).toBe(true);
  const originalScrollStyle = await content.evaluate(node => {
    const original = { maxHeight: node.style.maxHeight, overflowY: node.style.overflowY, scrollTop: node.scrollTop };
    node.scrollTop = 0;
    return original;
  });
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  // Negative control: programmatic reveal would pass overflow:hidden.
  // Clip an actual target so a real wheel must fail to reveal recovery.
  await content.evaluate(node => {
    const footer = [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Recovery key")!;
    node.style.maxHeight = `${footer.getBoundingClientRect().top - node.getBoundingClientRect().top + footer.getBoundingClientRect().height / 2}px`;
    node.style.overflowY = "hidden";
  });
  try {
    await expect.poll(async () => (await recoveryGeometry()).contained).toBe(false);
    await pointInsideScrollport();
    await page.mouse.wheel(0, 1000);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
    expect((await recoveryGeometry()).contained).toBe(false);
  } finally {
    await content.evaluate((node, original) => {
      node.style.maxHeight = original.maxHeight; node.style.overflowY = original.overflowY;
      node.scrollTop = original.scrollTop;
    }, originalScrollStyle);
  }
}
