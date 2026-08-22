import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * The entrance picker's layering, measured against the real compiled CSS.
 *
 * This exists because a unit test cannot catch the bug it guards. The native
 * map is drawn by @capacitor/google-maps BELOW the WebView, and the WebView is
 * punched through to reveal it -- so the sheet, its scrim and the page behind
 * must all be clear at that spot. Clearing the scrim is what makes the map
 * visible, and the scrim was also the only thing concealing the screen the
 * picker opens on top of. Clearing it alone left the onboarding features screen
 * and the picker drawn over each other on device.
 *
 * Transparent is not hidden. Both halves have to hold at once:
 *   - the page behind is HIDDEN while the picker is mounted, and
 *   - the sheet, its map surface and the map element stay TRANSPARENT.
 *
 * Class-string assertions proved neither. This loads the CSS the app actually
 * ships and reads computed styles in a browser.
 */

function builtStylesheet(): string {
  const cssDir = path.join(process.cwd(), "out", "_next", "static", "css");
  if (!fs.existsSync(cssDir)) {
    throw new Error(
      `No built CSS at ${cssDir}. Run \`npm run cap:build\` (or \`next build\`) first — ` +
        "this spec deliberately reads the shipped stylesheet rather than a fixture.",
    );
  }
  const file = fs
    .readdirSync(cssDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => path.join(cssDir, name))
    .find((full) => fs.readFileSync(full, "utf8").includes("one-location-map-native"));
  if (!file) throw new Error("Built CSS does not contain the native-map rules.");
  return fs.readFileSync(file, "utf8");
}

const PAGE = `
  <div data-app-scroll-root="true"><p>saved places behind</p></div>
  <div data-testid="one-location-onboarding"><h1>Keep your people updated.</h1></div>
  <div id="dialog-portal"></div>
`;

test.describe("entrance picker layering", () => {
  test("hides the screen behind only while the native picker is open", async ({ page }) => {
    await page.setContent(`<body>${PAGE}</body>`);
    await page.addStyleTag({ content: builtStylesheet() });

    const visibility = () =>
      page.evaluate(() => ({
        onboarding: getComputedStyle(
          document.querySelector('[data-testid="one-location-onboarding"]')!,
        ).visibility,
        shell: getComputedStyle(
          document.querySelector('[data-app-scroll-root="true"]')!,
        ).visibility,
      }));

    // Closed: nothing is hidden. A guard that always fires would break every
    // other screen, so this half matters as much as the other.
    expect(await visibility()).toEqual({ onboarding: "visible", shell: "visible" });

    // Open on native: the class goes on <html> and the sheet is portalled to
    // <body> — both are siblings of the page, which is why this cannot be done
    // from inside the app scroll root.
    await page.evaluate(() => {
      document.documentElement.classList.add("one-location-map-native");
      const sheet = document.createElement("div");
      sheet.setAttribute("data-testid", "save-location-modal");
      document.getElementById("dialog-portal")!.appendChild(sheet);
    });

    expect(await visibility()).toEqual({ onboarding: "hidden", shell: "hidden" });

    // The sheet itself must survive the guard, or the picker disappears too.
    await expect(page.getByTestId("save-location-modal")).toBeAttached();
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('[data-testid="save-location-modal"]')!,
          ).visibility,
      ),
    ).toBe("visible");
  });

  test("keeps the map box transparent so the native map still shows", async ({ page }) => {
    await page.setContent(`
      <div data-testid="save-location-modal" style="background:#fff">
        <div class="one-location-picker-native-surface" style="background:#eef2f7">
          <capacitor-google-map style="background:#ccc"></capacitor-google-map>
        </div>
      </div>`);
    await page.addStyleTag({ content: builtStylesheet() });
    await page.evaluate(() =>
      document.documentElement.classList.add("one-location-map-native"),
    );

    const backgrounds = await page.evaluate(() => {
      const bg = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).backgroundColor;
      return {
        sheet: bg('[data-testid="save-location-modal"]'),
        surface: bg(".one-location-picker-native-surface"),
        map: bg("capacitor-google-map"),
      };
    });

    // Any painted pixel here hides the native map underneath.
    for (const [layer, colour] of Object.entries(backgrounds)) {
      expect(colour, `${layer} must not paint over the native map`).toBe(
        "rgba(0, 0, 0, 0)",
      );
    }
  });
});
