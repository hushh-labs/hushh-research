import { expect, type Locator } from "@playwright/test";

export async function assertNeutralFocusedCircleType(type: Locator) {
  await expect(type).toHaveCSS("font-size", "14px");
  await type.focus();
  const group = type.locator("..");
  await expect(group).toHaveAttribute("data-slot", "input-group");
  const colors = await group.evaluate(element => {
    const reference = document.createElement("span");
    reference.style.backgroundColor = "var(--app-neutral-fill)";
    element.appendChild(reference);
    const actual = getComputedStyle(element).backgroundColor;
    const expected = getComputedStyle(reference).backgroundColor;
    reference.remove();
    return { actual, expected };
  });
  expect(colors.actual).toBe(colors.expected);
  expect(await type.evaluate(input => getComputedStyle(input).boxShadow)).not.toMatch(/0px 0px 0px 3px/);
  await expect(group).toHaveCSS("box-shadow", /3px/);
}
