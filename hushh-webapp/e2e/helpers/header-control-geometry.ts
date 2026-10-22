import { expect, type Locator, type Page } from "@playwright/test";

/** Rendered geometry and theme colour, shared by the existing header journeys. */
export async function expectHeaderControl(control: Locator, heading: Locator, animated = false) {
  const target = (await control.boundingBox())!;
  const glyph = (await control.locator("svg").last().boundingBox())!;
  for (const [actual, expected] of [[target.width, 44], [target.height, 44], [glyph.width, 22], [glyph.height, 22]])
    expect(actual).toBeCloseTo(expected, 2);
  await expect.poll(() => control.evaluate((node) => getComputedStyle(node).color)).toBe(
    await heading.evaluate((node) => getComputedStyle(node).color),
  );
  if (animated) await expect(control.locator("svg").last()).toHaveCSS("opacity", "1");
}

/** Exercise the real Chats/Connectors controls and their existing focus contract. */
export async function verifyChatHeaderControls(page: Page, theme: "light" | "dark") {
  await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
  await page.setViewportSize({ width: 390, height: 720 });
  const trigger = page.getByRole("button", { name: "Open drawer", exact: true });
  await trigger.click();
  const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
  const close = chats.getByRole("button", { name: "Close chat history" });
  await expect(close).toBeVisible();
  await expectHeaderControl(close, chats.locator("[data-agent-history-title]"), true);
  await close.click({ position: { x: 8, y: 22 } });
  await expect(chats).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("button", { name: "Open Connectors", exact: true }).click();
  const connectors = page.getByRole("dialog", { name: "Connectors", exact: true });
  await connectors.getByTestId("profile-connector-row-gmail").getByRole("button").first().click();
  for (const label of ["Back to connectors", "Close connectors"])
    await expectHeaderControl(connectors.getByRole("button", { name: label, exact: true }), connectors.locator("header h2"));
  await connectors.getByRole("button", { name: "Back to connectors" }).click();
  await expect(connectors.getByTestId("profile-connector-row-gmail").getByRole("button").first()).toBeFocused();
  await connectors.getByRole("button", { name: "Close connectors" }).click();
  await expect(trigger).toBeFocused();
}

/** Profile's smaller circle and ripple retain their full touch target. */
export async function expectProfileHeaderControl(control: Locator, page: Page) {
  const geometry = await control.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const circle = getComputedStyle(node, "::before");
    const ripple = node.querySelector('.morphy-ripple-host')!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, background: style.backgroundColor,
      border: style.borderTopWidth, diameter: rect.width - parseFloat(circle.left) - parseFloat(circle.right),
      radius: circle.borderRadius, rippleWidth: ripple.width };
  });
  expect(geometry.width).toBe(44);
  expect(geometry.height).toBe(44);
  expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
  expect(geometry.border).toBe("0px");
  expect(geometry.diameter).toBeCloseTo(44 * 0.78, 1);
  expect(geometry.rippleWidth).toBeCloseTo(44 * 0.78, 1);
  expect(geometry.radius).toBe("50%");
  const glyph = (await control.locator("svg").boundingBox())!;
  expect(glyph.width).toBeCloseTo(22, 2);
  expect(glyph.height).toBeCloseTo(22, 2);
  const foreground = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--foreground)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(control).toHaveCSS("color", foreground);
}
