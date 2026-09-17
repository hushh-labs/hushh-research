import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";

// Only fixed-label menu screenshots are permitted; never capture the transcript,
// whole page, profile, credentials, or owner IDs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appOrigin = process.env.REVIEWER_APP_ORIGIN || "http://localhost:3000";
await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs: 120000 });
const browser = await reviewer.chromium.launch({ headless: true });
let session;
try {
  session = await reviewer.openSession(browser, "/");
  const { page } = session;
  await page.getByRole("radio", { name: "One, your cloud agent", exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("radio", { name: /Puppy One, on your machine/ }).click();
    const start = page.getByRole("button", { name: "Start a Puppy chat", exact: true });
    await start.waitFor();
    await start.click();
    const frameSample = page.evaluate(() => new Promise((resolve) => {
      const deltas = [];
      let start = 0, previous = 0;
      const frame = (now) => {
        if (!start) start = now;
        if (previous) deltas.push(now - previous);
        previous = now;
        if (now - start < 400) return requestAnimationFrame(frame);
        deltas.sort((a, b) => a - b);
        resolve({ samples: deltas.length,
          medianMs: Math.round(deltas[Math.floor(deltas.length / 2)] * 10) / 10,
          p95Ms: Math.round(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] * 10) / 10 });
      };
      requestAnimationFrame(frame);
    }));
    await page.getByRole("button", { name: "Open chat history", exact: true }).click();
    const frameTiming = await frameSample;
    const drawer = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    await drawer.waitFor();
    const header = drawer.getByRole("heading", { name: "Puppy chats", exact: true });
    const createButton = drawer.getByRole("button", { name: "Create new chat", exact: true });
    const headerBox = await header.boundingBox();
    const createBox = await createButton.boundingBox();
    const searchBox = await drawer.getByRole("searchbox", { name: "Search chats", exact: true }).boundingBox();
    assert.ok(createBox && createBox.height <= 40, "New chat must not inherit the default 50px minimum");
    assert.ok(searchBox && createBox && Math.abs(searchBox.width - createBox.width) <= 1,
      "New chat and search have matching insets");
    const topBarBox = await page.locator(".agent-chat-header").boundingBox();
    const drawerBox = await drawer.boundingBox();
    assert.ok(topBarBox && drawerBox && Math.abs(drawerBox.y - topBarBox.y - topBarBox.height) <= 1,
      "drawer meets the actual chat header without a reserved-shell gap");
    assert.equal(await createButton.locator('svg [opacity="0.2"]').count(), 0,
      "Plus glyph has no square backing");
    if (process.env.REVIEWER_SAFE_UI_SCREENSHOTS === "true") {
      mkdirSync(path.join(repoRoot, "tmp", "chat-ui-plan"), { recursive: true });
      await createButton.screenshot({ path: path.join(repoRoot, "tmp", "chat-ui-plan", `new-chat-${viewport.width}.png`) });
    }
    assert.ok(headerBox && createBox && Math.abs(headerBox.x - createBox.x) <= 1,
      "history heading and new-chat control share the same left inset");
    const padding = await createButton.evaluate((el) => {
      const css = getComputedStyle(el);
      return { left: css.paddingLeft, right: css.paddingRight, top: css.paddingTop, bottom: css.paddingBottom };
    });
    assert.equal(padding.left, padding.right, "symmetric new-chat horizontal padding");
    assert.equal(padding.top, padding.bottom, "symmetric new-chat vertical padding");
    const action = drawer.getByRole("button", { name: "Open actions for New chat", exact: true });
    await action.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const renameOption = page.getByRole("menuitem", { name: "Rename chat", exact: true });
    await renameOption.hover();
    await page.waitForFunction(() => {
      const item = document.querySelector('[role="menuitem"][data-highlighted]');
      const icon = item?.querySelector("svg");
      return item && icon && getComputedStyle(item).color === getComputedStyle(icon).color;
    });
    assert.equal(await renameOption.evaluate((el) => getComputedStyle(el).cursor), "pointer");
    if (process.env.REVIEWER_SAFE_UI_SCREENSHOTS === "true") {
      mkdirSync(path.join(repoRoot, "tmp", "chat-ui-plan"), { recursive: true });
      await menu.screenshot({ path: path.join(repoRoot, "tmp", "chat-ui-plan", `menu-${viewport.width}.png`) });
    }
    const geometry = await menu.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { inside: box.x >= 0 && box.y >= 0 &&
        box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
        viewBoxes: [...el.querySelectorAll("svg")].map((svg) => svg.getAttribute("viewBox")) };
    });
    assert.equal(geometry.inside, true, "history menu must stay inside viewport");
    assert.ok(geometry.viewBoxes.every((value) => value === "0 0 256 256"), "canonical icons");
    await page.getByRole("menuitem", { name: "Rename chat", exact: true }).click();
    const input = drawer.getByRole("textbox", { name: "Rename chat", exact: true });
    await input.waitFor();
    assert.equal(await input.evaluate((el) => el === document.activeElement), true, "rename autofocus");
    await input.fill("UI acceptance chat");
    await drawer.getByRole("button", { name: "Save chat name", exact: true }).click();
    await page.mouse.move(viewport.width - 5, viewport.height / 2);
    await drawer.getByRole("button", { name: "Open actions for UI acceptance chat", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "One, your cloud agent", exact: true }).click();
    await page.getByRole("button", { name: "Open chat history", exact: true }).click();
    assert.equal(await drawer.getByRole("button", { name: "Open actions for UI acceptance chat", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: /Puppy One, on your machine/ }).click();
    await page.getByRole("button", { name: "Open chat history", exact: true }).click();
    await drawer.getByRole("button", { name: "Open actions for UI acceptance chat", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete chat", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
    await page.mouse.move(viewport.width - 5, viewport.height / 2);
    await page.keyboard.press("Escape");
    await start.waitFor();
    const motion = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"][aria-label="Agent chat history"]');
      return getComputedStyle(el).transitionDuration.split(",").map((x) => parseFloat(x) * 1000);
    });
    assert.ok(motion.every((ms) => ms <= 150), "drawer motion budget");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.getByRole("dialog", { name: "Agent chat history", includeHidden: true })
      .evaluate((el) => ({ property: getComputedStyle(el).transitionProperty,
        duration: getComputedStyle(el).transitionDuration }));
    assert.ok(reduced.property === "none" || parseFloat(reduced.duration) === 0,
      "reduced-motion drawer");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await reviewer.assertVaultContinuity(page, "chat UI plan");
    session.readOnlyGuard.assertNoBlockedMutation();
    session.capture.assertNoCriticalApiFailures("chat UI plan");
    console.log(JSON.stringify({ viewport: viewport.width, menu: "pass", rename: "pass",
      deletion: "pass", isolation: "pass", icons: "pass", motion: "pass", vault: "pass" }));
    console.log(JSON.stringify({ viewport: viewport.width, browserFrameTiming: frameTiming }));
    await page.getByRole("radio", { name: "One, your cloud agent", exact: true }).click();
  }
  await page.getByRole("button", { name: "Open Profile", exact: true }).click();
  const closeProfile = page.getByRole("button", { name: "Close Profile", exact: true });
  await closeProfile.waitFor();
  assert.equal(await closeProfile.locator('svg [opacity="0.2"]').count(), 0, "close glyph has no square backing");
  assert.equal(await closeProfile.evaluate(el => getComputedStyle(el).boxShadow), "none");
  if (process.env.REVIEWER_SAFE_UI_SCREENSHOTS === "true") {
    await closeProfile.screenshot({ path: path.join(repoRoot, "tmp", "chat-ui-plan", "profile-close.png") });
  }
  await closeProfile.click();
  await reviewer.assertVaultContinuity(page, "Profile close");
  console.log("Profile close glyph and flat surface: pass");
} finally {
  await session?.context.close();
  await browser.close();
}
