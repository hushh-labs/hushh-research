import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-guest-preview-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/guest-preview.tsx"),
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
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
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

test("Circle and agent tours animate, repeat, and respect reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setContent(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root { --app-fullscreen-flow-content-offset: 0px; --app-scroll-bottom-pad: 0px; }</style></head><body><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  const preview = page.getByTestId("guest-preview");
  await preview.getByRole("button", { name: "Finance", exact: true }).click();
  const icon = preview.locator('[data-circle-selected="true"]');
  // Real GSAP writes a finite transform tween; no simulated video/player UI.
  await expect.poll(() => icon.getAttribute("style")).toContain("transform");
  const firstTransform = await icon.evaluate(
    (node) => getComputedStyle(node).transform,
  );
  await expect
    .poll(() => icon.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe(firstTransform);
  const copy = preview.getByRole("heading", {
    name: "Finance Circle",
  });
  await expect(copy.locator("..")).toHaveCSS("opacity", "1");
  await expect(preview.locator("[data-circle-tour]")).toHaveAttribute(
    "data-circle-tour",
    "stopped",
  );
  await expect(
    preview.getByRole("button", { name: /pause|replay/i }),
  ).toHaveCount(0);
  await expect(preview.getByText("Examples", { exact: true })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(icon).toHaveCSS("transform", "none");
  await preview.getByRole("button", { name: "Business", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: "Business Circle" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Meet your agents" }).click();
  await expect(preview.getByText("One", { exact: true })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Observe the short typing state across the whole reveal rather than rely
  // on a polling request landing in its brief visible window on WebKit.
  await preview.evaluate((root) => {
    const observer = new MutationObserver(() => {
      const typing = root.querySelector("[data-chat-typing]");
      if (typing && Number(getComputedStyle(typing).opacity) > 0.1) {
        root.setAttribute("data-typing-observed", "true");
        observer.disconnect();
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  });
  await preview.getByRole("button", { name: "See what’s next" }).click();
  const answers = preview.locator("[data-chat-answer]");
  const turns = preview.locator("[data-chat-turn]");
  const cta = preview.getByRole("button", {
    name: "Create your One",
    exact: true,
  });
  const restingCta = (await cta.boundingBox())!;
  await expect(answers.first()).toHaveCSS("opacity", "0");
  await expect(turns.first().locator("[data-chat-character]").last()).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(answers.first()).toHaveCSS("opacity", "1");
  await expect(preview).toHaveAttribute("data-typing-observed", "true");
  await expect(turns.first().locator("[data-chat-activity]")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(turns.last()).toBeHidden();
  await expect(turns.last()).toHaveAttribute("data-chat-active", "true", {
    timeout: 10000,
  });
  await expect(turns.first()).toBeHidden();
  await expect(turns.last().locator("[data-chat-character]").last()).toHaveCSS(
    "opacity",
    "1",
    { timeout: 10000 },
  );
  await expect(answers.last()).toHaveCSS("opacity", "1");
  await expect(turns.last().locator("[data-chat-typing]")).toHaveCSS(
    "opacity",
    "0",
  );
  await expect(preview.locator("[data-chat-viewport]")).toHaveCount(0);
  expect(
    Math.abs((await cta.boundingBox())!.y - restingCta.y),
    "chat animation must not move the CTA",
  ).toBeLessThanOrEqual(1);
  await expect(preview.getByTestId("preview-chat-prompt")).toHaveText([
    "Find 30 free minutes tomorrow afternoon",
    "Can you share my location with my Family Circle for the next 2 hours, until I reach home?",
  ]);
  await expect(answers.first()).toContainText("Open 30-minute slots tomorrow:");
  await expect(answers.last()).toContainText(
    "Stop sharing early when you reach home.",
  );
  await expect(preview.getByText("Preview", { exact: true })).toBeVisible();
  await expect(
    preview.getByText("Connect and share on your terms."),
  ).toHaveCount(0);
  await expect(
    preview.getByRole("button", { name: /pause|replay/i }),
  ).toHaveCount(0);
  await expect(preview.getByText("An example conversation")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(answers.first()).toHaveCSS("opacity", "1");
  await expect(answers.last()).toHaveCSS("opacity", "1");
  await expect(preview.locator("[data-chat-character]").first()).toHaveCSS(
    "opacity",
    "1",
  );
  await preview.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(turns.first()).toBeVisible();
  await expect(turns.last()).toBeHidden();
});

for (const viewport of [
  { width: 320, height: 568, top: 20, bottom: 0 },
  { width: 375, height: 667, top: 20, bottom: 0 },
  { width: 393, height: 852, top: 59, bottom: 34 },
  { width: 390, height: 664, top: 0, bottom: 0 },
  { width: 768, height: 1024, top: 24, bottom: 20 },
  { width: 1440, height: 900, top: 0, bottom: 0 },
]) {
  for (const dark of [false, true]) {
    test(`three uncluttered screens ${viewport.width}x${viewport.height} ${dark ? "dark" : "light"}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setContent(
        `<html class="${dark ? "dark" : ""}" data-invite="true"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root { --app-fullscreen-flow-content-offset: 0px; --app-scroll-bottom-pad: 0px; --app-safe-area-top-effective: ${viewport.top}px; --app-safe-area-bottom-effective: ${viewport.bottom}px; }</style></head><body><div id="root"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await awaitProductFont(page);
      const screen = page.getByTestId("guest-preview");
      for (let step = 1; step <= 3; step++) {
        await expect(screen).toHaveAttribute("data-preview-step", String(step));
        await expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
        const supportingInk = await screen.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--app-secondary-label)";
          element.appendChild(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          const colors = Array.from(
            element.querySelectorAll(
              '[data-ui-role="row-description"], [data-ui-role="caption"]',
            ),
            (copy) => getComputedStyle(copy).color,
          );
          return { expected, colors: [...new Set(colors)] };
        });
        expect(
          supportingInk.colors,
          "readable supporting copy in both themes",
        ).toEqual([supportingInk.expected]);
        expect(
          (await screen.locator("header").boundingBox())!.y,
        ).toBeGreaterThanOrEqual(viewport.top);
        const size = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));
        await page.screenshot({
          path: testInfo.outputPath(`screen-${step}.png`),
          animations: "disabled",
        });
        expect(size.width, "no horizontal scrolling").toBeLessThanOrEqual(
          viewport.width + 1,
        );
        expect(
          size.height,
          "one mobile viewport, no scrolling",
        ).toBeLessThanOrEqual(viewport.height + 1);
        const next = screen.getByRole("button", {
          name:
            step === 1
              ? "Meet your agents"
              : step === 2
                ? "See what’s next"
                : "Join this Circle",
          exact: true,
        });
        const bounds = (await next.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(
          viewport.height - viewport.bottom + 1,
        );
        expect(
          await page.locator("html").getAttribute("data-started"),
        ).toBeNull();
        if (step === 1) {
          await screen
            .getByRole("button", { name: "Friends", exact: true })
            .click();
          await expect(
            screen.getByText("Keep your friends and shared plans together."),
          ).toBeVisible();
          const nodes = await screen
            .locator(
              '[aria-label="Explore Circles"] button, [data-preview-center]',
            )
            .all();
          const boxes = await Promise.all(
            nodes.map((node) => node.boundingBox()),
          );
          const center = (await screen
            .locator("[data-preview-center]")
            .boundingBox())!;
          expect(
            Math.abs(center.width - center.height),
            "The brand tile stays square on short screens",
          ).toBeLessThanOrEqual(1);
          for (const ring of await screen.locator("[data-orbit-ring]").all()) {
            const bounds = (await ring.boundingBox())!;
            expect(
              Math.abs(bounds.width - bounds.height),
              "Orbit rings must be true circles, never ellipses",
            ).toBeLessThanOrEqual(1);
          }
          for (let i = 0; i < boxes.length; i++)
            for (const other of boxes.slice(i + 1)) {
              const box = boxes[i]!;
              expect(
                box.x + box.width <= other!.x + 1 ||
                  other!.x + other!.width <= box.x + 1 ||
                  box.y + box.height <= other!.y + 1 ||
                  other!.y + other!.height <= box.y + 1,
                "Circle nodes must not overlap",
              ).toBe(true);
            }
        }
        if (step === 2) {
          // Keep the longest single-word label intact even at 320px in WebKit.
          expect(
            await screen
              .getByText("Calendar", { exact: true })
              .evaluate((label) => {
                const range = document.createRange();
                range.selectNodeContents(label);
                return range.getClientRects().length;
              }),
          ).toBe(1);
          await screen
            .getByRole("button", { name: "Calendar", exact: true })
            .click();
          await expect(
            screen.getByText("Stay ahead of your schedule."),
          ).toBeVisible();
          // Every auto-tour item must fit, including descriptions longer than
          // the initially selected Finance copy on short phones.
          for (const agent of await screen
            .locator("[data-agent-tour] button")
            .all()) {
            await agent.click();
            expect(
              (await next.boundingBox())!.y +
                (await next.boundingBox())!.height,
            ).toBeLessThanOrEqual(viewport.height - viewport.bottom + 1);
          }
        }
        if (step === 3) {
          const scenes = screen.locator("[data-chat-scenes]");
          for (const name of ["Calendar", "Location"]) {
            await screen.getByRole("button", { name, exact: true }).click();
            await expect(
              screen.locator('[data-chat-active="true"]'),
            ).toHaveCount(1);
            const geometry = await scenes.evaluate((el) => ({
              excessHeight: el.scrollHeight - el.clientHeight,
              excessWidth: el.scrollWidth - el.clientWidth,
              overflow: getComputedStyle(el).overflowY,
            }));
            expect(
              geometry.excessHeight,
              "complete exchange, no clipped response",
            ).toBeLessThanOrEqual(1);
            expect(geometry.excessWidth).toBeLessThanOrEqual(1);
            expect(geometry.overflow).toBe("visible");
          }
          await page.screenshot({
            path: testInfo.outputPath("screen-3-location.png"),
            animations: "disabled",
          });
        }
        await next.click();
      }
      await expect(page.locator("html")).toHaveAttribute(
        "data-started",
        "true",
      );
      expect(errors).toEqual([]);
    });
  }
}
