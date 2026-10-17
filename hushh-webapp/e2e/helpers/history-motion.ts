import { expect, type Page } from "@playwright/test";
import { mountAppChrome, expectPaneMotionReleased, expectPaneRestingAtFrame, sampleHistoryMotion } from "./drawer-geometry";

export async function verifyHistoryMovement(page: Page, measureMotion: boolean) {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mountAppChrome(page, 74);
  const chrome = () => page.evaluate(() => [document.querySelector("main")!.getBoundingClientRect().x,
    document.querySelector("[data-fixture-bottom-bar]")!.getBoundingClientRect().y]);
  const before = await chrome();
  const dialog = page.locator("[data-agent-history-drawer]");
  await expect(dialog).toHaveAttribute("data-state", "closed");
  await expectPaneMotionReleased(dialog);
  if (measureMotion) {
    const motion = await sampleHistoryMotion(page, "open");
    // An instantaneous endpoint jump passes a settled screenshot but fails here.
    expect(motion.frames.some(frame => frame.x > -motion.width + 1 && frame.x < -1), JSON.stringify(motion)).toBe(true);
    expect(motion.frames.find(frame => frame.x > -motion.width + 1)?.elapsed).toBeLessThan(100);
    expect(Math.abs(motion.frames.at(-1)!.x - motion.restingX)).toBeLessThanOrEqual(1);
    expect(motion.after).toEqual(motion.before);
  } else {
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create new chat" })).toBeVisible();
  await expectPaneRestingAtFrame(page, dialog);
  expect(await chrome()).toEqual(before);
  const measured = await dialog.evaluate(frame => {
    const title = frame.querySelector("h2")!;
    const body = frame.querySelector<HTMLElement>("aside")!;
    const before = [title.getBoundingClientRect().x, body.getBoundingClientRect().x];
    const dispatch = (type: string, x: number, time: number) => {
      const point = { identifier: 1, clientX: x, clientY: 320 };
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: [point] }, changedTouches: { value: [point] }, timeStamp: { value: time } });
      body.dispatchEvent(event);
    };
    dispatch("touchstart", 160, 100); dispatch("touchmove", 110, 220);
    const after = [title.getBoundingClientRect().x, body.getBoundingClientRect().x];
    dispatch("touchcancel", 110, 240);
    return { before, after, frameTransform: (frame as HTMLElement).style.transform };
  });
  expect(measured.after[0]! - measured.before[0]!).toBeCloseTo(-50, 0);
  expect(measured.after[1]! - measured.before[1]!).toBeCloseTo(-50, 0);
  expect(measured.frameTransform).toContain("translate3d");
  expect(measured.after[0]! - measured.after[1]!).toBeCloseTo(measured.before[0]! - measured.before[1]!, 0);
  await expectPaneRestingAtFrame(page, dialog);
  await expect(dialog).toHaveAttribute("aria-hidden", "false");
  await expectPaneRestingAtFrame(page, dialog);
  await expectPaneMotionReleased(dialog);
  if (measureMotion) {
    const exit = await sampleHistoryMotion(page, "close");
    expect(exit.frames.some(frame => frame.x < -1 && frame.x > -exit.width + 1), JSON.stringify(exit)).toBe(true);
    expect(exit.frames.at(-1)!.x).toBeCloseTo(-exit.width - exit.shadowClearance, 0);
  } else {
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveAttribute("data-state", "closed");
    await expectPaneMotionReleased(dialog);
    await expect(dialog).toBeHidden();
  }
  expect(await chrome()).toEqual(before);
}

