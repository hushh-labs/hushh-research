import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The boot surface, measured in a real browser.
 *
 * One surface for the whole cold-start chain: it is the same element for
 * every stage, nothing on it moves when the stage changes (zero layout
 * shift), the mark sits on the viewport centre to half a pixel, the copy
 * hangs at equal insets on the 8 pt grid, every line fits whole (again with
 * the text widened, as CI's Linux faces set it), the live line is announced
 * politely under an accessible name with AA contrast, reduced motion leaves a
 * still surface, and the iOS launch geometry matches the splash it continues.
 *
 * The negative control renders the sequence the app shipped before (a new
 * loader per guard, in different boxes) and the same one-surface, no-shift
 * check must reject it.
 *
 * BOOT_SURFACE_SHOT_DIR also captures each stage at 393 in light and dark,
 * and a frame strip plus a video of a full boot.
 */
let script: string;
let css: string;

const HALF_PX = 0.5;
const STAGES = ["session", "vault", "phone", "setup", "workspace"] as const;
const ALL_STAGES = ["session", "redirect", "reconnect", "vault", "phone", "setup", "workspace"] as const;
const LINES: Record<(typeof ALL_STAGES)[number], string> = {
  session: "Checking it's you",
  redirect: "Taking you to sign in",
  reconnect: "Reconnecting securely",
  vault: "Opening your vault",
  phone: "Checking your number",
  setup: "Checking your setup",
  workspace: "Getting One ready",
};
const TITLE = "Hussh One is getting ready";
// The labels the old per-guard loaders painted (fixture LEGACY table).
const LEGACY_LABELS: Record<(typeof STAGES)[number], string> = {
  session: "Checking session...",
  vault: "Checking vault...",
  phone: "Checking phone requirement...",
  setup: "Checking setup...",
  workspace: "Opening chat…",
};
// Splash.imageset: a 2732 px square, the ink box at x 1174..1558, y 1165..1567.
const SPLASH = { size: 2732, left: 1174, top: 1165, width: 385, height: 403 };
const SHOT_DIR = process.env.BOOT_SURFACE_SHOT_DIR;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-surface-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: { alias: [
      ...[
        "lib/services/vault-service", "lib/vault/vault-context",
        "lib/services/vault-bootstrap-service", "lib/services/vault-method-service",
        "lib/services/vault-method-prompt-local-service", "lib/services/vault-quick-unlock-trust-local-service",
        "lib/vault/prf-auth", "lib/utils/native-download", "lib/utils/clipboard", "lib/testing/native-test",
      ].map((name) => ({ find: `@/${name}`, replacement: path.join(root, "e2e/fixtures/boot-vault-services.ts") })),
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/boot-surface.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

type OpenOptions = {
  width: number;
  height: number;
  dark: boolean;
  reduced?: boolean;
  native?: boolean;
  stage?: string;
};

async function open(page: Page, options: OpenOptions) {
  const { width, height, dark, reduced = false, native = false, stage } = options;
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: dark ? "dark" : "light" });
  await page.route("http://localhost/boot-surface", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${[dark ? "dark" : "", native ? "native-ios" : ""].join(" ")}"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/boot-surface${stage ? `#stage=${stage}` : ""}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await page.locator("[data-boot-surface]").waitFor({ state: "attached" });
}

async function settleIdle(page: Page) {
  await expect.poll(() => page.evaluate(() => window.bootFixture.state().phase), { timeout: 5_000 }).toBe("idle");
  await page.evaluate(() => { window.bootFixture.phases.length = 0; });
}

/** Hold a stage and wait until it is on screen with its entrance finished. */
async function showStage(page: Page, stage: string) {
  await page.evaluate((next) => window.bootFixture.set(next as never), stage);
  await expect(page.locator("[data-boot-line='current']")).toContainText(LINES[stage as keyof typeof LINES]);
  await expect.poll(() => page.evaluate(() => window.bootFixture.state().phase)).toMatch(/^(visible|launch)$/);
  // Measure at rest: the line's 6 pt entrance is motion, not layout, and a
  // loaded runner can otherwise read it mid-flight.
  await page.waitForFunction(() =>
    document.querySelector("[data-boot-line='current']")?.getAnimations().every((animation) => animation.playState === "finished") ?? false,
  );
  await expect(async () => {
    const a = await measure(page);
    await page.waitForTimeout(80);
    const b = await measure(page);
    expect(a.mark).toEqual(b.mark);
    expect(b.surfaceOpacity).toBe(1);
    expect(b.lineCount).toBe(1);
  }).toPass();
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Geometry = {
  viewport: { width: number; height: number };
  scrollWidth: number;
  surfaceCount: number;
  surfaceOpacity: number;
  phase: string | null;
  mark: Box;
  copy: Box;
  title: Box & { clipped: boolean };
  lines: Box;
  line: (Box & { clipped: boolean }) | null;
  lineCount: number;
  live: { text: string; politeness: string | null };
  contrast: { title: number; line: number };
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const box = (node: Element): Box => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const surface = document.querySelector("[data-boot-surface]") as HTMLElement;
    const title = surface.querySelector("[data-boot-title]") as HTMLElement;
    const line = surface.querySelector("[data-boot-line='current']") as HTMLElement | null;
    const live = surface.querySelector("[role='status']") as HTMLElement;

    // Resolve any CSS colour (oklch, rgba, hex) to the sRGB pixel it paints
    // over the surface background, then take the WCAG ratio.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (bg: string, fg?: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      if (fg) {
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, 1, 1);
      }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const luminance = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (fg: string) => {
      const bg = getComputedStyle(surface).backgroundColor;
      const a = luminance(paint(bg));
      const b = luminance(paint(bg, fg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      surfaceCount: document.querySelectorAll("[data-boot-surface]").length,
      surfaceOpacity: Number(getComputedStyle(surface).opacity),
      phase: surface.getAttribute("data-boot-phase"),
      mark: box(surface.querySelector("[data-boot-mark]")!),
      copy: box(surface.querySelector("[data-boot-copy]")!),
      title: { ...box(title), clipped: title.scrollWidth > title.clientWidth + 0.5 },
      lines: box(surface.querySelector("[data-boot-lines]")!),
      line: line ? { ...box(line), clipped: line.scrollWidth > line.clientWidth + 0.5 } : null,
      lineCount: surface.querySelectorAll("[data-boot-line]").length,
      live: { text: live.textContent ?? "", politeness: live.getAttribute("aria-live") },
      contrast: {
        title: ratio(getComputedStyle(title).color),
        line: line ? ratio(getComputedStyle(line).color) : 0,
      },
    };
  });
}

const centreX = (b: Box) => b.left + b.width / 2;
const centreY = (b: Box) => b.top + b.height / 2;

function assertGrid(g: Geometry, label: string, native = false) {
  expect.soft(g.surfaceCount, `${label}: one surface`).toBe(1);
  expect.soft(g.scrollWidth, `${label}: horizontal scroll`).toBeLessThanOrEqual(g.viewport.width);

  // The mark: centred on the viewport to half a pixel, 96 pt on the web
  // grid, the splash's 403/2732 of the screen height on a phone shell.
  expect.soft(Math.abs(centreX(g.mark) - g.viewport.width / 2), `${label}: mark centre x`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(Math.abs(centreY(g.mark) - g.viewport.height / 2), `${label}: mark centre y`).toBeLessThanOrEqual(HALF_PX);
  const markSize = native ? (g.viewport.height * SPLASH.height) / SPLASH.size : 96;
  expect.soft(Math.abs(g.mark.width - markSize), `${label}: mark width`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(Math.abs(g.mark.height - markSize), `${label}: mark height`).toBeLessThanOrEqual(HALF_PX);

  // The copy hangs 32 pt below the mark, at equal 16 pt insets.
  expect.soft(g.copy.top - g.mark.bottom, `${label}: copy gap`).toBeCloseTo(32, 0);
  expect.soft(Math.abs(g.copy.left - (g.viewport.width - g.copy.right)), `${label}: equal insets`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(g.copy.left, `${label}: 16 pt gutter`).toBeCloseTo(16, 0);

  // Title and line: 24 pt rows, 8 pt apart, centred, whole.
  expect.soft(g.title.height, `${label}: title row`).toBeCloseTo(24, 0);
  expect.soft(g.lines.height, `${label}: line row`).toBeCloseTo(24, 0);
  expect.soft(g.lines.top - g.title.bottom, `${label}: title to line`).toBeCloseTo(8, 0);
  expect.soft(Math.abs(centreX(g.title) - g.viewport.width / 2), `${label}: title centred`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(g.title.clipped, `${label}: title clipped`).toBe(false);
  expect.soft(g.line, `${label}: a line`).not.toBeNull();
  if (g.line) {
    expect.soft(Math.abs(centreX(g.line) - g.viewport.width / 2), `${label}: line centred`).toBeLessThanOrEqual(HALF_PX);
    expect.soft(g.line.clipped, `${label}: line clipped`).toBe(false);
  }

  // Accessibility: announced politely, AA contrast for both rows.
  expect.soft(g.live.politeness, `${label}: polite live region`).toBe("polite");
  expect.soft(g.contrast.title, `${label}: title contrast`).toBeGreaterThanOrEqual(4.5);
  expect.soft(g.contrast.line, `${label}: line contrast`).toBeGreaterThanOrEqual(4.5);
}

/**
 * The one-surface, no-shift contract over a guard chain, as a list of
 * violations. Generic on purpose: it reads the status text's element and its
 * screen root, whatever renders them, so it can judge the legacy sequence too.
 */
async function walkChain(page: Page, mode: "new" | "legacy"): Promise<string[]> {
  const violations: string[] = [];
  let firstRoot: string | null = null;
  let firstAnchor: { x: number; y: number } | null = null;
  let firstMark: number[] | null = null;
  for (const stage of STAGES) {
    if (mode === "new") {
      await showStage(page, stage);
    } else {
      await page.evaluate((next) => window.bootFixture.legacy(next as never), stage);
      // Wait for THIS stage's loader: under load a bare selector can match the
      // previous stage's element before React swaps it, and the walk would
      // then miss the very jumps it exists to find.
      await page.locator(`[data-legacy-loader="${LEGACY_LABELS[stage]}"]`).waitFor();
    }
    const probe = await page.evaluate(() => {
      const anchor =
        document.querySelector("[data-boot-line='current']") ??
        document.querySelector("[data-legacy-loader] p");
      const root = anchor?.closest("[data-boot-surface],[data-legacy-loader]") as (HTMLElement & { __probeId?: string }) | null;
      if (!anchor || !root) return null;
      root.__probeId ??= Math.random().toString(36).slice(2);
      const r = anchor.getBoundingClientRect();
      const mark = root.querySelector("[data-boot-mark]")?.getBoundingClientRect();
      return {
        root: root.__probeId,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        mark: mark ? [mark.left, mark.top, mark.width, mark.height] : null,
      };
    });
    if (!probe) {
      violations.push(`${stage}: no status text on screen`);
      continue;
    }
    firstRoot ??= probe.root;
    firstAnchor ??= { x: probe.x, y: probe.y };
    if (probe.root !== firstRoot) violations.push(`${stage}: a new screen replaced the previous one`);
    if (Math.abs(probe.x - firstAnchor.x) > HALF_PX || Math.abs(probe.y - firstAnchor.y) > HALF_PX)
      violations.push(`${stage}: status text moved from ${firstAnchor.y.toFixed(1)} to ${probe.y.toFixed(1)}`);
    if (probe.mark) {
      firstMark ??= probe.mark;
      if (probe.mark.some((value, index) => Math.abs(value - firstMark![index]) > HALF_PX))
        violations.push(`${stage}: the mark moved`);
    }
  }
  return violations;
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), animations: "disabled" });
}

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 1440, height: 900 },
] as const;

for (const dark of [false, true])
  for (const viewport of VIEWPORTS)
    test(`boot surface sits on the grid at ${viewport.width}x${viewport.height} ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, { ...viewport, dark });
      await settleIdle(page);
      for (const stage of ALL_STAGES) {
        await showStage(page, stage);
        const label = `${viewport.width} ${dark ? "dark" : "light"} ${stage}`;
        const g = await measure(page);
        assertGrid(g, label);
        expect.soft(g.live.text, `${label}: announced line`).toBe(LINES[stage]);
        if (viewport.width === 393) await shot(page, `stage-${stage}-393-${dark ? "dark" : "light"}`);
      }
      // The surface has an accessible name.
      await expect(page.getByRole("region", { name: TITLE })).toHaveCount(1);

      // Widened text (CI's Linux faces set wider): every line still fits whole.
      await page.addStyleTag({ content: "[data-boot-surface] [data-boot-title],[data-boot-surface] [data-boot-line]{letter-spacing:0.3px}" });
      for (const stage of ALL_STAGES) {
        await showStage(page, stage);
        assertGrid(await measure(page), `${viewport.width} ${dark ? "dark" : "light"} ${stage} widened`);
      }
      expect(errors).toEqual([]);
    });

test("one surface and zero layout shift across the guard chain; the old sequence fails the same check", async ({ page, browserName }) => {
  await open(page, { width: 393, height: 852, dark: false });
  await settleIdle(page);
  await page.evaluate(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>)
          if (!entry.hadRecentInput) {
            (window as unknown as { __cls: number }).__cls += entry.value;
            const sources = (entry as unknown as { sources?: Array<{ node?: Element; previousRect: DOMRect; currentRect: DOMRect }> }).sources ?? [];
            (window as unknown as { __clsSources: string[] }).__clsSources ??= [];
            for (const source of sources)
              (window as unknown as { __clsSources: string[] }).__clsSources.push(
                `${source.node instanceof Element ? source.node.className || source.node.tagName : "text"} ${JSON.stringify(source.previousRect)} -> ${JSON.stringify(source.currentRect)}`,
              );
          }
      }).observe({ type: "layout-shift", buffered: false });
    } catch {
      // WebKit has no layout-shift entries; the geometry walk carries the proof there.
    }
  });

  expect(await walkChain(page, "new")).toEqual([]);
  expect((await measure(page)).surfaceCount).toBe(1);
  if (browserName === "chromium") {
    const cls = await page.evaluate(() => ({
      value: (window as unknown as { __cls: number }).__cls,
      sources: (window as unknown as { __clsSources?: string[] }).__clsSources ?? [],
    }));
    expect(cls.sources).toEqual([]);
    expect(cls.value).toBe(0);
  }

  // Negative control: the shipped-before sequence, judged by the same walk.
  await page.evaluate(() => window.bootFixture.set("chat"));
  await settleIdle(page);
  const legacy = await walkChain(page, "legacy");
  expect(legacy.length).toBeGreaterThan(0);
  expect(legacy.some((violation) => violation.includes("a new screen replaced"))).toBe(true);
  expect(legacy.some((violation) => violation.includes("status text moved"))).toBe(true);
  await shot(page, "negative-control-legacy-workspace-393-light");
});

test("a warm chain paints nothing; a slow one shows once and exits once", async ({ page }) => {
  // The virtual clock makes "inside the show-after window" exact: with real
  // timers a loaded runner stretches 50 ms waits past 200 ms, and then showing
  // the surface would be the correct outcome.
  await page.clock.install();
  await open(page, { width: 393, height: 852, dark: false });
  await page.clock.runFor(2_000);
  await settleIdle(page);
  // install() lets time keep flowing; pause it so only runFor moves it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const hold = (stage: string) => page.locator(`span[data-boot-stage="${stage}"]`).waitFor({ state: "attached" });

  // Fast path: three guards hand over inside the show-after window.
  await page.evaluate(() => window.bootFixture.set("session"));
  await hold("session");
  await page.clock.runFor(60);
  await page.evaluate(() => window.bootFixture.set("vault"));
  await hold("vault");
  await page.clock.runFor(60);
  await page.evaluate(() => window.bootFixture.set("chat"));
  await expect(page.getByTestId("first-usable")).toBeVisible();
  await page.clock.runFor(1_000);
  const fast = await page.evaluate(() => [...window.bootFixture.phases]);
  expect(fast).toContain("pending");
  expect(fast.filter((phase) => /visible|launch|exiting/.test(phase))).toEqual([]);

  // Slow path: shown once, no flash back, a single exit.
  await page.evaluate(() => { window.bootFixture.phases.length = 0; });
  await page.evaluate(() => window.bootFixture.set("vault"));
  await hold("vault");
  await page.clock.runFor(300);
  await page.evaluate(() => window.bootFixture.set("phone"));
  await hold("phone");
  await page.clock.runFor(300);
  await page.evaluate(() => window.bootFixture.set("chat"));
  await expect(page.getByTestId("first-usable")).toBeAttached();
  await page.clock.runFor(1_000);
  const slow = await page.evaluate(() => [...window.bootFixture.phases]);
  expect(slow).toEqual(["pending", "visible", "exiting", "idle"]);
});

test("hands the vault stage to the interactive unlock screen", async ({ page }) => {
  await open(page, { width: 393, height: 852, dark: false });
  await settleIdle(page);
  await showStage(page, "vault");
  await page.evaluate(() => window.bootFixture.set("unlock"));
  await expect.poll(() => page.evaluate(() => window.bootFixture.state().phase)).toBe("idle");
  const surface = page.locator("[data-boot-surface]");
  await expect(surface).toHaveAttribute("aria-hidden", "true");
  await expect(surface).toHaveCSS("pointer-events", "none");
  const passphrase = page.getByLabel("Vault passphrase");
  const target = await passphrase.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await passphrase.click();
  await expect(passphrase).toBeFocused();
  await shot(page, "handoff-vault-unlock-393-light");
});

for (const viewport of [{ width: 834, height: 1194 }, { width: 1194, height: 834 }]) {
  test(`real vault recovery remains reachable on tablet ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await open(page, { ...viewport, dark: false, native: true });
    await settleIdle(page);
    await page.evaluate(() => window.bootFixture.unlock(true));
    const content = page.locator("[data-vault-flow-content]");
    await expect(content).toHaveAttribute("data-vault-flow-step", "unlock");
    await settleIdle(page);
    const passphrase = page.getByLabel("Vault passphrase");
    const visibility = page.getByRole("button", { name: "Show passphrase", exact: true });
    const inputTarget = await passphrase.boundingBox();
    const visibilityTarget = await visibility.boundingBox();
    expect({
      entry: inputTarget!.height >= 44,
      visibility: visibilityTarget!.height >= 44 && visibilityTarget!.width >= 44,
    }).toEqual({ entry: true, visibility: true });
    // Measure the actual controls, not their larger decorative field shell.
    // Edge taps must focus/toggle without submitting any credential.
    await expect(passphrase).toHaveValue("");
    await passphrase.evaluate((node) => node.blur());
    await passphrase.click({ position: { x: 10, y: 4 } });
    await expect(passphrase).toBeFocused();
    await visibility.click({ position: { x: 4, y: 4 } });
    await expect(passphrase).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide passphrase", exact: true }).click();
    await expect(passphrase).toHaveAttribute("type", "password");
    await expect(passphrase).toHaveValue("");
    const surface = await page.locator("[data-vault-unlock-surface]").elementHandle();
    const supportingText = content.locator("[data-vault-flow-header] p").first();
    const originalTextSize = await supportingText.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const recoveryGeometry = () => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>("[data-vault-flow-content]")!;
      const dialog = document.querySelector<HTMLElement>("[data-vault-unlock-surface]")!;
      const box = scroll.getBoundingClientRect();
      const surface = dialog.getBoundingClientRect();
      const footer = [...scroll.querySelectorAll<HTMLButtonElement>("button")].filter((button) => ["Recovery key", "Sign out"].includes(button.textContent?.trim() ?? ""));
      return {
        centered: Math.abs(surface.left + surface.width / 2 - innerWidth / 2) <= 1,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        contained: footer.every((button) => {
          const r = button.getBoundingClientRect();
          return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 &&
            r.bottom <= innerHeight - Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-height")) + 1;
        }),
        targets: footer.length === 2 && footer.every((button) => button.getBoundingClientRect().height >= 44),
      };
    });
    // Resize the same dialog through full tablet and split-window widths,
    // including both sides of its responsive inset breakpoint. Rem-based
    // supporting copy grows; pixel-sized headings are not Dynamic Type proof.
    const sizes = [viewport, { width: 507, height: 834 }, { width: 639, height: 834 }, { width: 640, height: 834 }, viewport];
    for (const { width, height, keyboard } of sizes.flatMap((size) => [0, 320, 0].map((keyboard) => ({ ...size, keyboard })))) {
      await page.setViewportSize({ width, height });
      await page.evaluate((height) => {
        document.documentElement.style.setProperty("--kb-height", `${height}px`);
        document.documentElement.style.fontSize = "20px";
      }, keyboard);
      expect(await surface!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await supportingText.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThan(originalTextSize);
      const resizedInput = await passphrase.boundingBox();
      const resizedVisibility = await visibility.boundingBox();
      expect(resizedInput!.height).toBeGreaterThanOrEqual(44);
      expect(resizedVisibility!.height).toBeGreaterThanOrEqual(44);
      expect(resizedVisibility!.width).toBeGreaterThanOrEqual(44);
      const recovery = page.getByRole("button", { name: "Recovery key", exact: true });
      await content.evaluate((node) => { node.scrollTop = 0; });
      const scroll = await content.boundingBox();
      const overflows = await content.evaluate((node) => node.scrollHeight > node.clientHeight);
      if (keyboard === 320 && height === 834) expect(overflows).toBe(true);
      await page.mouse.move(scroll!.x + scroll!.width / 2, scroll!.y + scroll!.height / 2);
      if (overflows) {
        // Negative control: programmatic reveal would pass overflow:hidden.
        // A real wheel inside the scrollport must not pass that broken state.
        await content.evaluate((node) => { node.style.overflowY = "hidden"; });
        await page.mouse.wheel(0, 1000);
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
        expect((await recoveryGeometry()).contained).toBe(false);
        await content.evaluate((node) => { node.style.overflowY = ""; });
        // Synchronize the fixture's deliberate overflow mutation before the
        // next wheel. WebKit failed without this paint boundary.
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await page.mouse.wheel(0, 1000);
        await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      }
      // A positive scroll offset proves motion started, not that WebKit has
      // finished it. Require the full original geometry contract at settlement.
      await expect.poll(recoveryGeometry, {
        message: `Recovery footer ${width}x${height}, keyboard inset ${keyboard}`,
      }).toEqual({ centered: true, horizontalOverflow: false, contained: true, targets: true });
      await recovery.click();
      await expect(content).toHaveAttribute("data-vault-flow-step", "recovery");
      await page.getByRole("button", { name: "Passphrase", exact: true }).click();
      await expect(content).toHaveAttribute("data-vault-flow-step", "unlock");
    }
  });
}

test("reduced motion leaves a still surface that only fades", async ({ page }) => {
  await open(page, { width: 393, height: 852, dark: false, reduced: true });
  await settleIdle(page);
  await showStage(page, "vault");
  const motion = await page.evaluate(() => {
    const surface = document.querySelector("[data-boot-surface]")!;
    const style = (selector: string) => getComputedStyle(surface.querySelector(selector)!);
    return {
      mark: style("[data-boot-mark]").transform,
      markTransition: style("[data-boot-mark]").transitionDuration,
      ring: style(".boot-mark-ring").animationName,
      glyph: style(".boot-mark-glyph").animationName,
      line: style("[data-boot-line='current']").animationName,
    };
  });
  expect(motion.mark).toBe("none");
  expect(motion.markTransition.split(",").every((value) => parseFloat(value) === 0)).toBe(true);
  expect(motion.ring).toBe("none");
  expect(motion.glyph).toBe("none");
  // The line still arrives, as an opacity fade with no movement.
  expect(motion.line).toBe("boot-surface-reveal");
  assertGrid(await measure(page), "393 reduced motion");
  await shot(page, "reduced-motion-vault-393-light");
});

test("offline and a hung stage hand the person a way forward", async ({ page, context }) => {
  await page.clock.install();
  await open(page, { width: 393, height: 852, dark: false });
  await page.clock.runFor(2_000);
  await settleIdle(page);
  await page.evaluate(() => window.bootFixture.set("phone"));
  await page.clock.runFor(400);
  await expect(page.locator("[data-boot-line='current']")).toContainText("Checking your number");

  await context.setOffline(true);
  await expect(page.locator("[data-boot-line='current']")).toContainText("Waiting for a connection");
  await page.clock.runFor(200);
  await shot(page, "offline-phone-393-light");
  await context.setOffline(false);
  await expect(page.locator("[data-boot-line='current']")).toContainText("Checking your number");

  await page.clock.runFor(10_500);
  await expect(page.getByText("This is taking longer than usual.")).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  const target = await retry.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await page.clock.runFor(200);
  await shot(page, "stuck-phone-393-light");
});

for (const dark of [false, true])
  test(`iOS launch surface continues the splash (${dark ? "dark" : "light"})`, async ({ page, browserName }) => {
    await open(page, { width: 393, height: 852, dark, native: true, stage: "session" });
    await expect(page.locator("[data-boot-surface]")).toHaveAttribute("data-boot-phase", "launch");
    await expect(page.locator("[data-boot-line='current']")).toContainText(LINES.session);
    // Visible from the first frame on a phone: no show-after for the launch surface.
    await expect(page.locator("[data-boot-surface]")).toHaveCSS("opacity", "1");
    await expect(page.locator("[data-boot-surface]")).toHaveCSS(
      "background-color",
      dark ? "rgb(17, 17, 17)" : "rgb(255, 255, 255)",
    );
    const g = await measure(page);
    assertGrid(g, `ios launch ${dark ? "dark" : "light"}`, true);
    await shot(page, `ios-launch-session-393-${dark ? "dark" : "light"}`);

    // The glyph's ink lands where the splash's ink is, so the hand-over from
    // LaunchScreen.storyboard shows no change. Apple Color Emoji only ships on
    // Apple platforms; elsewhere the box geometry above carries the contract.
    if (process.platform !== "darwin" || browserName !== "webkit") return;
    const scale = g.viewport.height / SPLASH.size; // aspect-fill of a square on a tall screen
    const offsetX = (g.viewport.width - g.viewport.height) / 2;
    const expected = {
      left: offsetX + SPLASH.left * scale,
      top: SPLASH.top * scale,
      width: SPLASH.width * scale,
      height: SPLASH.height * scale,
    };
    const png = await page.screenshot({
      animations: "disabled",
      // Around the mark only: the title starts 32 pt below the ink (y 521).
      clip: { x: 106, y: 336, width: 181, height: 170 },
    });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const bg = [data[0], data[1], data[2]];
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 3;
        const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
        if (d > 24) {
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
    const dpr = info.width / 181; // screenshot pixels per CSS pixel
    const ink = {
      left: 106 + minX / dpr,
      top: 336 + minY / dpr,
      width: (maxX - minX + 1) / dpr,
      height: (maxY - minY + 1) / dpr,
    };
    test.info().annotations.push({
      type: "splash-ink",
      description: `rendered ${JSON.stringify(ink)} vs splash ${JSON.stringify(expected)}`,
    });
    for (const key of ["left", "top", "width", "height"] as const)
      expect.soft(Math.abs(ink[key] - expected[key]), `ink ${key} ${ink[key]} vs splash ${expected[key].toFixed(2)}`).toBeLessThanOrEqual(1.5);
  });

test("records a full boot for review", async ({ browser, browserName }) => {
  test.skip(!SHOT_DIR || browserName !== "chromium", "evidence capture only");
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      recordVideo: { dir: path.join(SHOT_DIR!, `video-${theme}`), size: { width: 393, height: 852 } },
    });
    const page = await context.newPage();
    await open(page, { width: 393, height: 852, dark, stage: "session" });
    const frames = path.join(SHOT_DIR!, `frames-${theme}`);
    fs.mkdirSync(frames, { recursive: true });
    let frame = 0;
    const capture = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(3, "0")}.png`) });
      }
    };
    await capture(8);
    for (const stage of ["vault", "phone", "workspace"] as const) {
      await page.evaluate((next) => window.bootFixture.set(next), stage);
      await capture(6);
    }
    await page.evaluate(() => window.bootFixture.set("chat"));
    await capture(10);
    await context.close();
  }
});
