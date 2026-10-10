import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The connected-person profile's action cluster, in a real browser.
 *
 * The cluster is a two-column CSS grid where Request and Share are placed
 * explicitly and the two Drive file actions are auto-placed. A third
 * auto-placed button does NOT join them: auto-placement skips the explicitly
 * occupied Manage row and drops the button underneath it. "Request scope"
 * therefore carries an explicit grid row, and this spec is the proof that it
 * sits with the file actions rather than below Manage access.
 *
 * The real `person-profile-page.module.css` is served verbatim. Its selectors
 * are plain class names, so the same markup order the component renders
 * reproduces the production layout without mounting React or needing auth.
 */

let server: Server;
let origin: string;

const CSS_PATH = path.join(
  process.cwd(),
  "components/connections/person-profile-page.module.css",
);

// Element order exactly as person-profile-page.tsx renders it.
const MARKUP = `
<div class="actions" aria-label="Relationship actions">
  <button class="request" data-id="request">Request</button>
  <button class="share" data-id="share">Share</button>
  <button data-id="request-files">Request files</button>
  <button data-id="ask-about-files">Ask about files</button>
  <button class="requestScope" data-id="request-scope">Request scope</button>
  <button class="manage" data-id="manage">Manage access</button>
</div>`;

test.beforeAll(async () => {
  const css = readFileSync(CSS_PATH, "utf8");
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<style>body{margin:0;padding:16px;font-family:system-ui}${css}</style>` +
        MARKUP,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function boxes(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-id]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return [element.dataset.id!, { top: rect.top, bottom: rect.bottom, height: rect.height }];
      }),
    ),
  );
}

test("Request scope sits with the file actions, above Manage access", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(origin);

  const rect = await boxes(page);

  // The two Drive file actions share a row.
  expect(Math.abs(rect["request-files"]!.top - rect["ask-about-files"]!.top)).toBeLessThan(2);

  // Request scope is below them...
  expect(rect["request-scope"]!.top).toBeGreaterThan(rect["request-files"]!.top);
  // ...and above Manage access. This is the regression the explicit grid row
  // exists to prevent: without it the button lands under Manage.
  expect(rect["request-scope"]!.bottom).toBeLessThanOrEqual(rect["manage"]!.top + 1);
});

test("Request scope matches the file actions' control sizing", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(origin);
  const rect = await boxes(page);

  // `.actions button` gives every control the same minimum target height, so
  // an unclassed file action and the new CTA must agree.
  expect(rect["request-scope"]!.height).toBeGreaterThanOrEqual(48);
  expect(rect["request-scope"]!.height).toBeCloseTo(rect["request-files"]!.height, 0);
});

test("the cluster stays within the phone column with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(origin);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
