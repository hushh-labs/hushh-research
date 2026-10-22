import { buildChatOnboardingFixture } from "./fixtures/chat-onboarding-build";
import { expect, test, type Page } from "@playwright/test";

import {
  awaitProductFont,
} from "./fixtures/product-font";

/**
 * One's onboarding chips, connect action and daily tip in a real browser with
 * the real modules and the app stylesheet. JSDOM has no layout, so it cannot
 * see a chip rail that scrolls the page sideways on a phone, a tap target that
 * shrank under 44px, or an action that slid out of the reading column.
 *
 * Run: CI=1 npx playwright test e2e/chat-onboarding.layout.spec.ts --project=chromium
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  ({ css, script } = await buildChatOnboardingFixture(process.cwd()));
});

async function mount(page: Page, theme: "light" | "dark", journey: boolean | "ordinary" = false) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/chat-onboarding*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme}"><head><title>Chat onboarding layout contract</title><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto(`http://localhost/chat-onboarding${journey === "ordinary" ? "?ordinary-name" : journey ? "?name-journey" : ""}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(journey ? page.getByLabel("Chat profile name") : page.getByTestId("transcript")).toBeVisible();
  return errors;
}

test("access explanations fit a narrow phone without requesting device permissions", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mount(page, "light");
  const permissionRequests: string[] = [];
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = () => { throw new Error("Unexpected location prompt"); };
  });
  page.on("request", request => { if (request.url().includes("/api/")) permissionRequests.push(request.url()); });
  await page.goto("http://localhost/chat-onboarding?access");
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "What One knows" })).toBeVisible();
  await expect(page.getByText(/No apps connected/)).toBeVisible();
  const sharing = page.getByRole("link", { name: "Review sharing permissions" });
  await expect(sharing).toHaveAttribute("href", "/one/consent");
  expect((await sharing.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(permissionRequests).toEqual([]);
  const deviceExplanation = page.getByText(/Opening this panel requests no device permissions/);
  await deviceExplanation.scrollIntoViewIfNeeded();
  await expect(deviceExplanation).toBeVisible();
  await page.getByRole("heading", { name: "One access", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("access-phone.png"), fullPage: true });
});

test("an ordinary chat name saves encrypted memory, updates the label and survives re-entry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let encrypted: unknown = null;
  let revision = 0;
  let failWrite = true;
  const writes: string[] = [];
  await page.route("**/__fixture/identity", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postData()!);
      if (failWrite) { failWrite = false; await route.fulfill({ status: 500 }); return; }
      encrypted = route.request().postDataJSON().encrypted;
      revision++;
    }
    await route.fulfill({ json: { encrypted, revision } });
  });
  await page.route("**/__fixture/one", route => route.fulfill({ json: {
    status: "preferred_name_update_ready", preferred_name: "Ruby",
  } }));
  const errors = await mount(page, "light", "ordinary");
  const submit = async () => {
    await page.getByRole("textbox", { name: "Your reply" }).fill("Please call me Ruby");
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };
  await submit();
  await expect(page.getByRole("status")).toHaveText("Couldn't save your name. Please try again.");
  await expect(page.getByLabel("Chat profile name")).toHaveText("One");
  await submit();
  await expect(page.getByRole("status")).toHaveText("Preferred name saved.");
  await expect(page.getByLabel("Chat profile name")).toHaveText("Ruby");
  expect(writes).toHaveLength(2);
  for (const write of writes) {
    expect(write).not.toContain("Ruby");
    expect(JSON.parse(write).encrypted.algorithm).toBe("aes-256-gcm");
  }
  await page.reload();
  await page.addScriptTag({ content: script });
  await expect(page.getByLabel("Chat profile name")).toHaveText("Ruby");
  expect(errors).toEqual([]);
});

test("preferred name entry saves privately, refreshes the profile label, and recovers from failure", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let encrypted: unknown = null;
  let revision = 0;
  let failWrite = true;
  const writes: string[] = [];
  await page.route("**/__fixture/identity", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postData()!);
      if (failWrite) { failWrite = false; await route.fulfill({ status: 500 }); return; }
      encrypted = route.request().postDataJSON().encrypted;
      revision++;
    }
    await route.fulfill({ json: { encrypted, revision } });
  });
  await page.route("**/__fixture/one", async route => {
    const request = route.request().postDataJSON();
    await route.fulfill({ json: { status: "onboarding_name_assessed", request_id: request.onboarding_name_request,
      decision: "name", preferred_name: "Roopmann" } });
  });
  const errors = await mount(page, "light", true);
  await page.getByRole("button", { name: "Something else" }).click();
  await expect(page.getByText("Okay. What should I call you?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip this question" })).toBeVisible();
  await page.getByRole("textbox", { name: "Your reply" }).fill("Please call me Roopmann");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Chat profile name")).toHaveText("One");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Chat profile name")).toHaveText("Roopmann");
  await expect(page.getByText("Nice to meet you, Roopmann. What should I help with first?")).toBeVisible();
  expect(writes).toHaveLength(2);
  for (const write of writes) {
    expect(write).not.toContain("Roopmann");
    expect(JSON.parse(write).encrypted.algorithm).toBe("aes-256-gcm");
  }
  // Re-entering uses persisted ciphertext, not an optimistic component label.
  await page.reload();
  await page.addScriptTag({ content: script });
  await expect(page.getByLabel("Chat profile name")).toHaveText("Roopmann");
  expect(errors).toEqual([]);
});

test("a picked name labels One at once, holds through the save, and reverts when declined", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let encrypted: unknown = null;
  let revision = 0;
  const writes: string[] = [];
  await page.route("**/__fixture/identity", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postData()!);
      encrypted = route.request().postDataJSON().encrypted;
      revision++;
    }
    await route.fulfill({ json: { encrypted, revision } });
  });
  const errors = await mount(page, "light", true);
  const label = page.getByLabel("Chat profile name");
  // Every distinct text the label shows, so a drop back to "One" cannot hide.
  const watchLabel = () => page.evaluate(() => {
    const target = document.querySelector('[aria-label="Chat profile name"]')!;
    const seen = [target.textContent ?? ""];
    new MutationObserver(() => {
      const text = target.textContent ?? "";
      if (seen.at(-1) !== text) seen.push(text);
    }).observe(target, { childList: true, characterData: true, subtree: true });
    (window as unknown as { labelSeen: string[] }).labelSeen = seen;
  });
  const labelSeen = () => page.evaluate(() => (window as unknown as { labelSeen: string[] }).labelSeen);
  const answerRest = async () => {
    await page.getByRole("button", { name: "Skip this question" }).click();
    await page.getByRole("button", { name: "Casual" }).click();
  };

  // Declined: the pick shows at once, then nothing is stored or kept.
  await watchLabel();
  await page.getByRole("button", { name: "Call me Owner" }).click();
  await expect(label).toHaveText("Owner");
  await answerRest();
  await page.getByRole("button", { name: "Don't save" }).click();
  await expect(page.getByRole("button", { name: "What do you remember about me?" })).toBeVisible();
  await expect(label).toHaveText("One");
  expect(writes).toHaveLength(0);
  expect(await labelSeen()).toEqual(["One", "Owner", "One"]);

  // Saved: the label never drops to "One" between the write and the re-read.
  await page.reload();
  await page.addScriptTag({ content: script });
  await expect(label).toHaveText("One");
  await watchLabel();
  await page.getByRole("button", { name: "Call me Owner" }).click();
  await answerRest();
  await page.getByRole("button", { name: "Save to memory" }).click();
  await expect(page.getByText(/^Saved\. You can change it anytime in Memory/)).toBeVisible();
  const starter = page.getByRole("button", { name: "What's on my calendar this week?" });
  await starter.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("saved-starters-phone.png") });
  await starter.click();
  await expect(page.getByRole("textbox", { name: "Your reply" })).toHaveValue("What's on my calendar this week?");
  await expect(label).toHaveText("Owner");
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toContain("Owner");
  expect(await labelSeen()).toEqual(["One", "Owner"]);
  expect(errors).toEqual([]);
});

test("Skip invalidates a slow semantic answer before it can save", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let finishReply!: () => Promise<void>;
  let writes = 0;
  await page.route("**/__fixture/identity", async route => {
    if (route.request().method() === "PUT") writes++;
    await route.fulfill({ json: { encrypted: null, revision: 0 } });
  });
  await page.route("**/__fixture/one", async route => {
    const request = route.request().postDataJSON();
    await new Promise<void>(resolve => { finishReply = async () => {
      await route.fulfill({ json: { status: "onboarding_name_assessed", request_id: request.onboarding_name_request,
        decision: "name", preferred_name: "Stale" } }); resolve();
    }; });
  });
  await mount(page, "dark", true);
  await page.getByRole("button", { name: "Something else" }).click();
  await page.getByRole("textbox", { name: "Your reply" }).fill("Stale");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => typeof finishReply).toBe("function");
  await page.getByRole("button", { name: "Skip this question" }).click();
  await finishReply();
  await expect(page.getByRole("textbox", { name: "Your reply" })).toBeEnabled();
  await expect(page.getByLabel("Chat profile name")).toHaveText("One");
  expect(writes).toBe(0);
});

async function assertContract(page: Page, viewportWidth: number) {
  // No sideways page scroll: the chip rail wraps inside the column.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);


  await expect(page.getByTestId("chat-onboarding-chips")).toBeVisible();

  const chips = page.getByTestId("chat-onboarding-chips").getByRole("button");
  await expect(chips).toHaveCount(10);
  await expect(chips).toHaveText([
    "Location", "Mail", "Calendar", "Finance", "Advisor", "Wallet", "Consent", "Memory", "Messages", "Skip this question",
  ]);
  const boxes = await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  expect(boxes[9].y).toBeGreaterThanOrEqual(Math.max(...boxes.slice(0, 9).map((box) => box.bottom)));
  if (viewportWidth < 640) {
    for (let row = 0; row < 3; row += 1) {
      const group = boxes.slice(row * 3, row * 3 + 3);
      expect(new Set(group.map((box) => box.y)).size).toBe(1);
      expect(group[0].right).toBeLessThanOrEqual(group[1].x);
      expect(group[1].right).toBeLessThanOrEqual(group[2].x);
      if (row > 0) expect(group[0].y).toBeGreaterThanOrEqual(boxes[(row - 1) * 3].bottom);
    }
  }
  for (const box of await chips.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect),
  )) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  }

  // Chips and the connect action start at the assistant column's left edge.
  const bubble = (await page.locator('[data-message-role="assistant"]').first().boundingBox())!;
  const firstChip = (await chips.first().boundingBox())!;
  const connect = (await page.getByTestId("chat-onboarding-connect").boundingBox())!;
  expect(Math.abs(firstChip.x - bubble.x)).toBeLessThanOrEqual(6);
  expect(Math.abs(connect.x - bubble.x)).toBeLessThanOrEqual(6);
  expect(connect.height).toBeGreaterThanOrEqual(44);

  // Starters occupy three equal desktop tracks and one phone track. Follow-ups
  // remain quiet text rows. Both are borderless, left-aligned and focusable.
  for (const testId of ["agent-prompt-suggestions", "agent-follow-up-suggestions"]) {
    const prompts = page.getByTestId(testId).getByRole("button");
    const isStarter = testId === "agent-prompt-suggestions";
    await expect(prompts).toHaveCount(isStarter ? 3 : 2);
    const geometries = await prompts.evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { x: box.x, y: box.y, width: box.width, right: box.right, height: box.height,
        textAlign: style.textAlign, border: style.borderTopWidth, fill: style.backgroundColor };
    }));
    for (const geometry of geometries) {
      if (!isStarter || viewportWidth < 640) expect(Math.abs(geometry.x - bubble.x)).toBeLessThanOrEqual(6);
      expect(geometry.right).toBeLessThanOrEqual(viewportWidth);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.textAlign).toBe("left");
      expect(geometry.border).toBe("0px");
      expect(geometry.fill).toBe("rgba(0, 0, 0, 0)");
    }
    if (isStarter) {
      for (const geometry of geometries) {
        expect(Math.abs(geometry.width - geometries[0].width)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.height - geometries[0].height)).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(geometries[0].x - bubble.x)).toBeLessThanOrEqual(6);
      if (viewportWidth >= 640) {
        expect(geometries.every((geometry) => geometry.y === geometries[0].y)).toBe(true);
        const firstGap = geometries[1].x - geometries[0].right;
        expect(Math.abs(firstGap - (geometries[2].x - geometries[1].right))).toBeLessThanOrEqual(1);
        // Compact starters use the production grid's sm:gap-3 (12px).
        expect(firstGap).toBe(12);
      }
    } else if (viewportWidth < 600) {
      expect((await prompts.last().boundingBox())!.height).toBeGreaterThan(44);
    }
    await prompts.first().focus();
    await expect(prompts.first()).toBeFocused();
    expect(await prompts.first().evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");
  }

  // The tip's dismiss control keeps a full tap target.
  const dismiss = (await page.getByRole("button", { name: "Dismiss tip" }).boundingBox())!;
  expect(dismiss.width).toBeGreaterThanOrEqual(44);
  expect(dismiss.height).toBeGreaterThanOrEqual(44);
  const tip = page.getByTestId("chat-onboarding-daily-tip");
  const tipBox = (await tip.boundingBox())!;
  const suggestionsBox = (await page.getByTestId("agent-prompt-suggestions").boundingBox())!;
  expect(tipBox.y).toBeGreaterThanOrEqual(suggestionsBox.y + suggestionsBox.height);
  expect(tipBox.y - (suggestionsBox.y + suggestionsBox.height)).toBeLessThanOrEqual(16);
  const [labelStyle, bodyStyle] = await Promise.all([
    tip.locator('[data-profile-role="group-label"]').evaluate((node) => getComputedStyle(node).fontSize),
    tip.locator('[data-profile-role="description"]').evaluate((node) => getComputedStyle(node).fontSize),
  ]);
  expect([labelStyle, bodyStyle]).toEqual(["10px", "12px"]);
}

type Rgba = [number, number, number, number];

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Selects the person's own message and reads the highlight the browser would
 * paint, resolved to pixels by painting it on a canvas: the selection colour
 * over each stop of the bubble's accent gradient, and the selected text alone.
 * The regression this guards: the theme highlight is the accent at 28%, so on
 * the accent bubble selected text was invisible.
 */
async function ownBubbleSelection(page: Page) {
  const text = page.locator('[data-message-role="user"] span').first();
  return text.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (...colors: string[]) => {
      context.clearRect(0, 0, 1, 1);
      for (const color of colors) {
        context.fillStyle = "rgba(1, 2, 3, 0.5)";
        context.fillStyle = color;
        if (context.fillStyle === "rgba(1, 2, 3, 0.5)") throw new Error(`unparsed colour ${color}`);
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data] as [number, number, number, number];
    };
    const bubble = getComputedStyle(node.parentElement!);
    const own = getComputedStyle(node, "::selection");
    const accent = bubble.getPropertyValue("--app-accent").trim();
    const accentDeep = bubble.getPropertyValue("--app-accent-deep").trim();
    return {
      ownBackground: own.backgroundColor,
      themeBackground: getComputedStyle(document.body, "::selection").backgroundColor,
      bubbleImage: bubble.backgroundImage,
      text: paint(own.color),
      stops: [accent, accentDeep].map((stop) => ({
        fill: paint(stop),
        highlight: paint(stop, own.backgroundColor),
      })),
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`phone (${theme})`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("three rows of choices fit a narrow phone with Skip below", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      const errors = await mount(page, theme);
      await assertContract(page, 320);
      expect(errors).toEqual([]);
    });

    test("chips wrap inside the column with full tap targets", async ({ page }) => {
      const errors = await mount(page, theme);
      await assertContract(page, 390);
      await page.screenshot({ path: test.info().outputPath(`phone-${theme}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });

    test("selected text on the person's own bubble stays readable", async ({ page }) => {
      const errors = await mount(page, theme);
      const selected = await ownBubbleSelection(page);
      await page
        .locator('[data-message-role="user"]')
        .first()
        .screenshot({ path: test.info().outputPath(`selection-${theme}.png`) });

      expect(selected.bubbleImage).toContain("linear-gradient");
      expect(selected.ownBackground).not.toBe(selected.themeBackground);
      for (const stop of selected.stops) {
        // The highlight separates from the bubble (WCAG 1.4.11 non-text, 3:1)
        // and the selected text reads on the highlight (WCAG AA body, 4.5:1).
        expect(contrast(stop.highlight, stop.fill)).toBeGreaterThanOrEqual(3);
        expect(contrast(selected.text, stop.highlight)).toBeGreaterThanOrEqual(4.5);
      }
      expect(errors).toEqual([]);
    });
  });

  test.describe(`desktop (${theme})`, () => {
    test("starter tracks remain symmetric at the tablet breakpoint", async ({ page }) => {
      await mount(page, theme);
      await page.setViewportSize({ width: 640, height: 900 });
      await assertContract(page, 640);
    });

    test.use({ viewport: { width: 1440, height: 900 } });

    test("chips sit under One's reply, and the keyboard walks them", async ({ page }) => {
      const errors = await mount(page, theme);
      await assertContract(page, 1440);

      const chips = page.getByTestId("chat-onboarding-chips").getByRole("button");
      await chips.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(chips.nth(1)).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.getByRole("button", { name: "Skip this question" })).toBeFocused();

      await page.getByRole("button", { name: "Dismiss tip" }).click();
      await expect(page.getByTestId("chat-onboarding-daily-tip")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`desktop-${theme}.png`), fullPage: true });
      expect(errors).toEqual([]);
    });
  });
}
