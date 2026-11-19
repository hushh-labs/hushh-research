import { type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";

const KEYBOARD_CASE = "keeps chat navigation and keyboard controls reachable at 768x852";
const CAPTURE_TIMEOUT_MS = 500;

export async function captureKeyboardGeometry(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.title !== KEYBOARD_CASE) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const geometry = await Promise.race([
      page.evaluate(() => Array.from(
        document.querySelectorAll(
          "[data-app-shell-width],[data-direct-message-page],main,header,textarea,form",
        ),
      )
        .map((node) => ({
          tag: node.tagName,
          cls: node.className,
          box: node.getBoundingClientRect().toJSON(),
          minHeight: getComputedStyle(node).minHeight,
          padding: getComputedStyle(node).padding,
          flex: getComputedStyle(node).flex,
          height: getComputedStyle(node).height,
        }))),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (geometry === null) return;
    fs.writeFileSync(testInfo.outputPath("keyboard-geometry.json"), JSON.stringify(geometry, null, 2));
  } catch {
    // Diagnostic capture must never replace the test's assertion or timeout result.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
