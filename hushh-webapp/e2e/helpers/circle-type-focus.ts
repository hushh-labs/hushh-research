import { expect, type Locator } from "@playwright/test";

export async function assertThinFocusedCircleType(type: Locator) {
  await expect(type).toHaveCSS("font-size", "14px");
  await type.focus();
  const accent = await type.evaluate(element => {
    const reference = document.createElement("span");
    reference.style.borderColor = "var(--app-accent)";
    element.parentElement!.appendChild(reference);
    const expected = getComputedStyle(reference).borderColor;
    reference.remove();
    return expected;
  });
  await expect(type).toHaveCSS("border-color", accent);
  await expect(type).toHaveCSS("border-width", "1px");
  await expect(type).toHaveCSS("box-shadow", "none");
}
