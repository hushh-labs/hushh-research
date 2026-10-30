/**
 * Summary -> Open -> Back, in a real browser.
 *
 * The shipped `ToolResultCard` and the shipped `openOfferedMail` are bundled and
 * mounted over the real compiled `app/globals.css`, so the click handlers, the
 * Tailwind, the 44px touch targets and the POST are all real. Playwright answers
 * the Open request, which is what lets the spec assert the exact request body --
 * the ordinal, the offer revision and the conversation the offer was made under.
 *
 * What this does NOT cover, and must not be reported as covering: the
 * authenticated app shell. A reviewer-authenticated run needs REVIEWER_UID,
 * REVIEWER_VAULT_PASSPHRASE and E2E_REVIEWER_SIGNIN=1 plus the local stack and a
 * connected Gmail account, none of which are available here --
 * `e2e/one-voice-acceptance.spec.ts` silently skips without them.
 */

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_REVISION = 7;

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-voice-mail-open-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        // Candidates are derived from every transformed module, so a class the
        // card renders cannot be missing from the CSS. A hand-maintained list
        // would let an unregistered class emit no style and still pass.
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
    resolve: {
      alias: [
        {
          find: "@/lib/services/api-service",
          replacement: path.join(
            root,
            "e2e/fixtures/one-voice-mail-open-boundaries.ts",
          ),
        },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/one-voice-mail-open.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

type OpenRequest = {
  conversation_id?: unknown;
  ordinal?: unknown;
  offer_revision?: unknown;
};

const ORIGINALS: Record<number, { subject: string; sender: string; body: string }> =
  {
    1: {
      subject: "Q3 deck",
      sender: "Priya Nair",
      body: "Can you send the Q3 deck before Friday? The board copy needs it.",
    },
    3: {
      subject: "March invoice",
      sender: "Acme Billing",
      body: "Invoice 4471 for March is now 14 days overdue.",
    },
  };

async function mount(
  page: Page,
  dark: boolean,
  options: { supersede?: boolean } = {},
) {
  const requests: OpenRequest[] = [];
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.route("http://localhost/mail-open.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: script }),
  );
  await page.route("http://localhost/mail-open-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/mail-open.js"></script></body></html>`,
    }),
  );
  await page.route("**/api/one/voice/mail/open", (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as OpenRequest;
    requests.push(body);
    if (options.supersede) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { code: "MAIL_OFFER_SUPERSEDED", current_revision: 9 },
        }),
      });
    }
    const original = ORIGINALS[Number(body.ordinal)];
    if (!original) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { code: "MAIL_OFFER_UNRESOLVED", offered: 3 },
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          source_ref: `mail:${body.ordinal}`,
          subject: original.subject,
          sender: original.sender,
          received_at: "2026-09-28T09:00:00+00:00",
          body: original.body,
          body_truncated: false,
        },
        coverage: { returned: 1, content_depth: "message" },
      }),
    });
  });
  await page.goto("http://localhost/mail-open-fixture");
  await awaitProductFont(page);
  await expect(
    page.getByTestId("one-voice-mail-detail"),
    runtimeErrors.join("; "),
  ).toBeVisible();
  return { requests, runtimeErrors };
}

const rowOrder = (page: Page) =>
  page
    .getByLabel("Mail", { exact: true })
    .locator("> li")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-source-ref")),
    );

for (const width of [375, 1440])
  for (const dark of [false, true])
    test(`summary, open and back at ${width}px in ${dark ? "dark" : "light"}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { requests, runtimeErrors } = await mount(page, dark);

      // The summary: the answer, every returned row, and honest coverage.
      const card = page.getByTestId("one-voice-tool-result");
      await expect(card).toContainText("Priya needs the Q3 deck by Friday");
      await expect(card).toContainText("Priya wants the Q3 deck by Friday.");
      // Three rows, including the one with nothing to name.
      const before = await rowOrder(page);
      expect(before).toEqual(["mail:1", "mail:2", "mail:3"]);
      await expect(page.getByTestId("one-voice-mail-coverage")).toContainText(
        "newest 3 messages",
      );

      // Every control clears the 44px touch floor.
      for (const button of await card.getByRole("button").all()) {
        const bounds = (await button.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }

      // Open the third row. Its ordinal is 3 even though row two is unlabelled.
      const opens = page.getByTestId("one-voice-mail-open");
      await expect(opens).toHaveCount(3);
      await expect(opens.nth(2)).toHaveAttribute("data-ordinal", "3");
      await opens.nth(2).click();

      const original = page.getByTestId("one-voice-mail-original");
      await expect(original).toContainText(
        "Invoice 4471 for March is now 14 days overdue.",
      );
      await expect(original).toContainText("Acme Billing");
      // The wire proves the binding: the server's ordinal, the offer it came
      // from, and the conversation the offer was made under.
      expect(requests).toEqual([
        {
          conversation_id: CONVERSATION_ID,
          ordinal: 3,
          offer_revision: OFFER_REVISION,
        },
      ]);

      // The original is inside the card, not on another route.
      const cardBox = (await card.boundingBox())!;
      const originalBox = (await original.boundingBox())!;
      expect(originalBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
      expect(originalBox.x + originalBox.width).toBeLessThanOrEqual(
        Math.min(cardBox.x + cardBox.width, width) + 1,
      );

      await testInfo.attach(
        `mail-open-${width}-${dark ? "dark" : "light"}.png`,
        { body: await page.screenshot({ fullPage: true }), contentType: "image/png" },
      );

      // Back: closing restores the same list, same order, same positions.
      await opens.nth(2).click();
      await expect(original).toHaveCount(0);
      expect(await rowOrder(page)).toEqual(before);
      await expect(card).toContainText("March invoice");

      // A second open resolves its own row, not the previous one.
      await opens.nth(0).click();
      await expect(page.getByTestId("one-voice-mail-original")).toContainText(
        "Can you send the Q3 deck before Friday?",
      );
      expect(requests.at(-1)).toEqual({
        conversation_id: CONVERSATION_ID,
        ordinal: 1,
        offer_revision: OFFER_REVISION,
      });
      expect(runtimeErrors).toEqual([]);
    });

test("a replaced list says so instead of opening another message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 900 });
  const { requests, runtimeErrors } = await mount(page, false, {
    supersede: true,
  });

  await page.getByTestId("one-voice-mail-open").nth(1).click();

  await expect(page.getByTestId("one-voice-mail-open-error")).toContainText(
    "This list has been replaced",
  );
  // The row's own content is never replaced by another message's.
  await expect(page.getByTestId("one-voice-mail-original")).not.toContainText(
    "Invoice 4471",
  );
  expect(requests).toEqual([
    { conversation_id: CONVERSATION_ID, ordinal: 2, offer_revision: OFFER_REVISION },
  ]);
  expect(runtimeErrors).toEqual([]);
});

/**
 * A spoken open, through the same consumer as a tap.
 *
 * The page dispatches the `one-voice:open-mail` directive event the provider
 * emits, so the card's listener, the same `openOfferedMail` call and the same
 * POST all run in a real browser. What this does not cover is the relay chain
 * that produces the event -- socket frame to reducer to provider to dispatch --
 * which needs the full provider and a faked socket; that part is covered by the
 * node tests, not here.
 */
async function speakOpen(
  page: Page,
  detail: { ordinal: number; offerRevision?: number; conversationId?: string },
) {
  return page.evaluate(
    ({ ordinal, offerRevision, conversationId }) =>
      new Promise<[string, string | undefined]>((resolve) => {
        window.dispatchEvent(
          new CustomEvent("one-voice:open-mail", {
            detail: {
              ordinal,
              offerRevision: offerRevision ?? 7,
              conversationId:
                conversationId ?? "22222222-2222-4222-8222-222222222222",
              settle: (status: string, reason?: string) =>
                resolve([status, reason]),
            },
          }),
        );
      }),
    detail,
  );
}

test("a spoken open shows the exact message and settles on the render", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 900 });
  const { requests, runtimeErrors } = await mount(page, false);
  const before = await rowOrder(page);

  const settled = await speakOpen(page, { ordinal: 3 });

  await expect(page.getByTestId("one-voice-mail-original")).toContainText(
    "Invoice 4471 for March is now 14 days overdue.",
  );
  // The same request a tap makes, with the same binding.
  expect(requests).toEqual([
    {
      conversation_id: CONVERSATION_ID,
      ordinal: 3,
      offer_revision: OFFER_REVISION,
    },
  ]);
  // Settled once the message is on screen, not when the handler returned.
  expect(settled).toEqual(["opened", undefined]);
  // The list is still there, in order: a spoken open must not take away the rows
  // the ordinal refers to.
  expect(await rowOrder(page)).toEqual(before);
  expect(runtimeErrors).toEqual([]);
});

test("a spoken open for a replaced list is refused before any request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 900 });
  const { requests, runtimeErrors } = await mount(page, false);

  const stale = await speakOpen(page, { ordinal: 3, offerRevision: 6 });
  const foreign = await speakOpen(page, {
    ordinal: 3,
    conversationId: "11111111-1111-4111-8111-111111111111",
  });

  expect(stale).toEqual(["failed", "offer_mismatch"]);
  expect(foreign).toEqual(["failed", "offer_mismatch"]);
  // Position three of another list is not position three of this one, and the
  // refusal lands before the network rather than after a wrong answer.
  expect(requests).toEqual([]);
  await expect(page.getByTestId("one-voice-mail-original")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
