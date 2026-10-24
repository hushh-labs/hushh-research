import { expect, type Locator } from "@playwright/test";

/** Measures the rendered role after the fixture has loaded the product font. */
export async function expectConsentTypography(
  locator: Locator,
  size: string,
  line: string,
  weight?: string,
) {
  const type = await locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
  });
  expect(type[0]).toBe(size);
  expect(type[1]).toBe(line);
  if (weight) expect(type[2]).toBe(weight);
  expect(type[3]).toContain("Plus Jakarta Sans");
}
