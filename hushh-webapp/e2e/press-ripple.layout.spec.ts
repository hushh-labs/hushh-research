import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Press contract in a real engine: a pointerdown on a control grows the
 * Material ripple from inside that control, clipped to its box, and the
 * control never scales. Under reduced motion the ripple is an opacity-only
 * layer. Unit coverage: __tests__/components/press-ripple.contract.test.tsx.
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "press-ripple-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: { alias: [
      { find: "@/lib/services/api-service", replacement: path.join(root, "e2e/fixtures/press-ripple-boundaries.ts") },
      { find: "@", replacement: root },
    ] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/press-ripple.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

async function openFixture(page: Page, reducedMotion: "reduce" | "no-preference") {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ reducedMotion });
  await page.setContent(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("press-ripple")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email", exact: true })).toBeVisible();
}

test("provider icons share the Google scale and labels share one start at phone and desktop widths", async ({ page }, testInfo) => {
  for (const width of [320, 393, 402, 430, 1440]) {
    await openFixture(page, "reduce");
    await page.setViewportSize({ width, height: 900 });
    await awaitProductFont(page);
    const starts: { icon: number; label: number }[] = [];
    for (const button of await page.getByTestId("auth-providers").getByRole("button").all()) {
      const geometry = await button.evaluate(element => {
        const box = element.getBoundingClientRect();
        const group = element.querySelector("[data-auth-provider-content]")!.getBoundingClientRect();
        const slot = element.querySelector("[data-auth-provider-icon]")!.getBoundingClientRect();
        const art = element.querySelector("[data-auth-provider-icon] > :first-child")!;
        let inkSize: number;
        if (art.tagName.toLowerCase() === "svg") {
          const svg = art as SVGSVGElement;
          const ink = svg.getBBox();
          const matrix = svg.getScreenCTM()!;
          const style = getComputedStyle(svg);
          const stroke = style.stroke === "none" ? 0 : parseFloat(style.strokeWidth);
          inkSize = Math.max((ink.width + stroke) * Math.hypot(matrix.a, matrix.b),
            (ink.height + stroke) * Math.hypot(matrix.c, matrix.d));
        } else {
          const ink = art.getBoundingClientRect();
          inkSize = Math.max(ink.width, ink.height);
        }
        const label = element.querySelector("[data-auth-provider-content] > span:last-child")!.getBoundingClientRect();
        return { box: box.toJSON(), group: group.toJSON(), slot: slot.toJSON(), label: label.toJSON(), inkSize };
      });
      expect(Math.abs(geometry.group.x + geometry.group.width / 2 - geometry.box.x - geometry.box.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.slot.y + geometry.slot.height / 2 - geometry.label.y - geometry.label.height / 2)).toBeLessThanOrEqual(1);
      expect(geometry.label.x - geometry.slot.right).toBeCloseTo(12, 0);
      expect(geometry.slot.width).toBe(24);
      expect(geometry.slot.height).toBe(24);
      expect(geometry.inkSize).toBeCloseTo(22, 0);
      expect(geometry.box.height).toBe(53);
      expect(geometry.label.right).toBeLessThanOrEqual(geometry.box.right - 18);
      expect(geometry.group.width).toBeLessThan(geometry.box.width);
      starts.push({ icon: geometry.slot.x, label: geometry.label.x });
    }
    expect(Math.max(...starts.map(item => item.icon)) - Math.min(...starts.map(item => item.icon))).toBeLessThanOrEqual(1);
    expect(Math.max(...starts.map(item => item.label)) - Math.min(...starts.map(item => item.label))).toBeLessThanOrEqual(1);
    if (width === 393) await page.getByTestId("auth-providers").screenshot({ path: testInfo.outputPath("provider-cta-393.png") });
  }
});

type PressReading = {
  /** md-ripple's own surface reports `.pressed` while the pointer is down. */
  materialPressed: boolean;
  /** The reduced-motion layer is pressed and actually painted. */
  flatOpacity: number | null;
  /** The ripple host fills the control and no more (clip box). */
  hostMatchesControl: boolean;
  /**
   * Whether the control is scaled mid-press. Tailwind v4 `scale-*` writes the
   * individual `scale` property, not `transform`, so both are read.
   */
  scaled: boolean;
};

async function readPress(control: Locator): Promise<PressReading> {
  return control.evaluate((button) => {
    const host = button.querySelector<HTMLElement>(":scope > .morphy-ripple-host");
    const surface = host
      ?.querySelector("md-ripple")
      ?.shadowRoot?.querySelector(".surface");
    const flat = host?.querySelector<HTMLElement>("[data-ripple-flat][data-pressed]");
    const a = button.getBoundingClientRect();
    const b = host?.getBoundingClientRect();
    return {
      materialPressed: Boolean(surface?.classList.contains("pressed")),
      flatOpacity: flat ? Number(getComputedStyle(flat).opacity) : null,
      hostMatchesControl: Boolean(
        b &&
          Math.abs(a.width - b.width) <= 2.5 &&
          Math.abs(a.height - b.height) <= 2.5 &&
          Math.abs(a.left - b.left) <= 1.5 &&
          Math.abs(a.top - b.top) <= 1.5,
      ),
      scaled: (() => {
        const style = getComputedStyle(button);
        const flatScale = style.scale === "none" || /^1(\s+1)?$/.test(style.scale);
        return style.transform !== "none" || !flatScale;
      })(),
    };
  });
}

/** Press with a real pointer, read mid-press, then release. */
async function press(page: Page, control: Locator, settle: (r: PressReading) => boolean) {
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  let reading = await readPress(control);
  // md-ripple commits `pressed` on its next Lit update; give it a few frames.
  await expect
    .poll(async () => {
      reading = await readPress(control);
      return settle(reading);
    }, { timeout: 2000 })
    .toBe(true)
    .catch(() => undefined);
  // Hold across the old 50ms press transition so a scale would be visible.
  await page.waitForTimeout(120);
  reading = { ...reading, scaled: (await readPress(control)).scaled };
  await page.mouse.up();
  return reading;
}

const TARGETS: Array<[string, (page: Page) => Locator]> = [
  ["stock Button", (page) => page.getByRole("button", { name: "Stock action" })],
  ["Create your One", (page) => page.getByRole("button", { name: "Create your One" })],
  ["Apple sign-in", (page) => page.getByRole("button", { name: "Continue with Apple" })],
  ["Google sign-in", (page) => page.getByRole("button", { name: "Continue with Google" })],
  ["Microsoft sign-in", (page) => page.getByRole("button", { name: "Continue with Microsoft" })],
  ["Email sign-in", (page) => page.getByRole("button", { name: "Continue with email" })],
  [
    "follow-up chip",
    (page) =>
      page
        .getByTestId("agent-follow-up-suggestions")
        .getByRole("button", { name: "Draft a reply to Sam" }),
  ],
  ["composer Send", (page) => page.getByRole("button", { name: "Send message" })],
];

const RIPPLED_CONTROLS = TARGETS.length + 4;

test("welcome starters keep foreground text without a hover background", async ({ page, browserName }) => {
  for (const motion of ["no-preference", "reduce"] as const) {
    await openFixture(page, motion);
    for (const dark of [false, true]) {
      await page.locator("html").evaluate((element, enabled) => element.classList.toggle("dark", enabled), dark);
      for (const width of [320, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const buttons = page.getByTestId("starter-suggestions").getByRole("button");
        const first = buttons.first();
        const foreground = await first.evaluate((button) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--foreground)";
          button.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
        await first.hover();
        await expect(first).toHaveCSS("color", foreground);
        await expect(first).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(first.locator(':scope > span[aria-hidden="true"]')).toHaveCSS("color", foreground);
        await expect.poll(() => first.evaluate((button) => {
          const host = button.querySelector(".morphy-ripple-host")!;
          const surface = host.querySelector("md-ripple")?.shadowRoot?.querySelector(".surface");
          const flat = host.querySelector("[data-ripple-flat]");
          return surface ? Number(getComputedStyle(surface, "::before").opacity) : flat ? Number(getComputedStyle(flat).opacity) : -1;
        })).toBe(0);
        await page.mouse.move(0, 0);
        await first.focus();
        // macOS WebKit uses Option+Tab to traverse buttons by default.
        await first.press(process.platform === "darwin" && browserName === "webkit" ? "Alt+Tab" : "Tab");
        await expect(buttons.nth(1)).toBeFocused();
        expect(await buttons.nth(1).evaluate((button) => button.matches(":focus-visible"))).toBe(true);
        await expect(buttons.nth(1)).not.toHaveCSS("box-shadow", "none");
      }
    }
  }
});

test("starter suggestions retain compact spacing, aligned tracks and accessible targets", async ({ page }) => {
  await openFixture(page, "no-preference");
  for (const width of [320, 393, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const buttons = page.getByTestId("starter-suggestions").getByRole("button");
    const frames = await buttons.evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.height).toBeGreaterThanOrEqual(44);
    if (width < 640) {
      expect(frames[0].x).toBe(frames[2].x);
      expect(frames[1].y - frames[0].y - frames[0].height).toBeLessThanOrEqual(4.5);
      expect(frames[2].y - frames[1].y - frames[1].height).toBeLessThanOrEqual(4.5);
    } else {
      expect(frames[0].y).toBe(frames[2].y);
      expect(Math.abs(frames[0].width - frames[2].width)).toBeLessThanOrEqual(0.5);
      expect(frames[0].height).toBeLessThan(100);
    }
  }
});

test("pointerdown grows a clipped ripple and never scales the control", async ({ page }) => {
  await openFixture(page, "no-preference");
  // Every control except the legacy chip carries one; the fixture renders two
  // follow-up chips, only one of which is pressed below.
  await expect(page.locator("md-ripple")).toHaveCount(RIPPLED_CONTROLS);

  for (const [name, locate] of TARGETS) {
    const reading = await press(page, locate(page), (r) => r.materialPressed);
    expect(reading.materialPressed, `${name}: ripple on pointerdown`).toBe(true);
    expect(reading.hostMatchesControl, `${name}: ripple clipped to control`).toBe(true);
    expect(reading.scaled, `${name}: no press scale`).toBe(false);
  }

  // Negative control: the pre-fix chip has no ripple and does scale, and the
  // same readings must say so.
  const legacy = await press(
    page,
    page.getByRole("button", { name: "Legacy chip" }),
    (r) => r.scaled,
  );
  expect(legacy.materialPressed).toBe(false);
  expect(legacy.hostMatchesControl).toBe(false);
  expect(legacy.scaled).toBe(true);
});

test("reduced motion swaps the ripple for an opacity-only press layer", async ({ page }) => {
  await openFixture(page, "reduce");
  await expect(page.locator('.morphy-ripple-host[data-ripple-mode="flat"]')).toHaveCount(
    RIPPLED_CONTROLS,
  );
  await expect(page.locator("md-ripple")).toHaveCount(0);

  for (const [name, locate] of TARGETS) {
    const reading = await press(
      page,
      locate(page),
      (r) => r.flatOpacity !== null && r.flatOpacity > 0,
    );
    expect(reading.flatOpacity, `${name}: flat layer painted`).toBeGreaterThan(0);
    expect(reading.flatOpacity, `${name}: flat layer is a tint`).toBeLessThan(0.5);
    expect(reading.materialPressed, `${name}: no growing ripple`).toBe(false);
    expect(reading.hostMatchesControl, `${name}: layer clipped to control`).toBe(true);
    expect(reading.scaled, `${name}: no press scale`).toBe(false);
  }
  // Released: the layer is gone again.
  await expect(page.locator("[data-ripple-flat][data-pressed]")).toHaveCount(0);
});
