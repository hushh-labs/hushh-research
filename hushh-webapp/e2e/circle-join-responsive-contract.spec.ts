import { expect, test, type Locator, type Page } from "@playwright/test";

// Real route + scroll root: guard the old double-reserved chrome regression,
// guest-only exploration, and the invitation handoff. No live invite redeemed.
const CODE = "SWDX-ENDP-B954";
const ROUTE = `/circle/join?code=${CODE}`;
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844, top: 59, bottom: 34 },
  { width: 430, height: 932 },
  { width: 390, height: 600 },
  { width: 768, height: 1024 },
];

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/one/location/circle-codes/public-preview", (route) =>
    route.fulfill({
      json: { circle: { name: "Family Circle", ownerDisplayName: "Alex" } },
    }),
  );
});

test("only the explicit One invite opens the introduction at the root", async ({ page }) => {
  // Cold WebKit must settle Firebase restoration before deciding guest entry.
  test.setTimeout(60000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL((url) => url.pathname === "/login", { timeout: 30000 });
  await expect(page.getByTestId("guest-preview")).toHaveCount(0);
  await page.goto("/?invite=one", { waitUntil: "domcontentloaded" });
  const preview = page.getByTestId("guest-preview");
  await expect(preview).toHaveAttribute("data-preview-step", "1");
  await preview.getByRole("button", { name: "Meet your agents" }).click();
  await preview.getByRole("button", { name: "See what’s next" }).click();
  await preview.getByRole("button", { name: "Create your One", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("redirect") === "/?invite=one");
  await expect(page.getByTestId("auth-step-primary")).toBeVisible();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.searchParams.get("invite") === "one");
  await expect(preview).toBeVisible();
});

function watchRuntime(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/Viewport argument key .* not recognized/i.test(message.text())
    )
      errors.push(message.text());
  });
  return errors;
}

async function expectHittable(locator: Locator) {
  await expect(locator).toBeInViewport();
  expect(
    await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        ),
      );
    }),
    "the action is covered by app chrome",
  ).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test(`three guest screens fit ${viewport.width}x${viewport.height} without dead scroll`, async ({
    page,
  }) => {
    const errors = watchRuntime(page);
    await page.setViewportSize(viewport);
    await page.goto(ROUTE);
    const preview = page.getByTestId("guest-preview");
    await expect(preview).toBeVisible();
    const top = "top" in viewport ? viewport.top : 0;
    const bottom = "bottom" in viewport ? viewport.bottom : 0;
    await page.addStyleTag({
      content: `:root { --app-safe-area-top-effective: ${top}px !important; --app-safe-area-bottom-effective: ${bottom}px !important; }`,
    });
    await page.evaluate(() => document.fonts.ready);
    for (let step = 1; step <= 3; step++) {
      await expect(preview).toHaveAttribute("data-preview-step", String(step));
      await expect(preview.getByRole("heading", { level: 1 })).toBeVisible();
      const measurements = await preview.evaluate((element) => {
        const root = document.querySelector<HTMLElement>(
          '[data-app-scroll-root="true"]',
        )!;
        const heading = element.querySelector("h1")!;
        return {
          x: document.documentElement.scrollWidth - window.innerWidth,
          y: root.scrollHeight - root.clientHeight,
          titleWidth: heading.scrollWidth - heading.clientWidth,
          ellipsis: getComputedStyle(heading).textOverflow,
        };
      });
      expect(measurements.x).toBeLessThanOrEqual(1);
      expect(measurements.y).toBeLessThanOrEqual(1);
      expect(measurements.titleWidth).toBeLessThanOrEqual(1);
      expect(measurements.ellipsis).not.toBe("ellipsis");
      const cta = preview.getByRole("button", {
        name:
          step === 1
            ? "Meet your agents"
            : step === 2
              ? "See what’s next"
              : "Join this Circle",
        exact: true,
      });
      await expect(cta).toBeEnabled();
      const bounds = (await cta.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        viewport.height - bottom,
      );
      await expectHittable(cta);
      if (step === 3) {
        await expectHittable(
          preview.getByRole("button", { name: "Sign in", exact: true }),
        );
        expect(
          (await preview
            .getByRole("button", { name: "Sign in", exact: true })
            .boundingBox())!.y,
        ).toBeGreaterThanOrEqual(top);
      } else {
        await expect(
          preview.getByRole("button", { name: "Sign in", exact: true }),
        ).toHaveCount(0);
      }
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/circle/join" &&
          url.searchParams.get("code") === CODE,
      );
      if (step < 3) await cta.click();
    }
    await expect(
      preview.getByRole("heading", { name: "Family Circle", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("the account action preserves the invite through sign-in and cancellation", async ({
  page,
}) => {
  await page.goto(ROUTE);
  const preview = page.getByTestId("guest-preview");
  await preview.getByRole("button", { name: "Meet your agents" }).click();
  await preview.getByRole("button", { name: "See what’s next" }).click();
  await preview
    .getByRole("button", { name: "Join this Circle", exact: true })
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/login" && url.searchParams.get("redirect") === ROUTE,
  );
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/circle/join" && url.searchParams.get("code") === CODE,
  );
  await expect(preview).toBeVisible();
});

test("the native token landing retains the invitation through all three screens and login", async ({ page }) => {
  const destination = "/circle/join?invite=browser_fixture_token";
  let claims = 0;
  await page.route("**/api/one/location/circle-invites/browser_fixture_token", (route) => route.fulfill({
    json: { invite: { id: "fixture", ownerLabel: "Alex", status: "active", durationHours: 24 } },
  }));
  await page.route("**/api/one/location/circle-invites/*/claim", (route) => {
    claims++;
    return route.fulfill({ status: 403, json: {} });
  });
  await page.goto(destination);
  const preview = page.getByTestId("guest-preview");
  await expect(preview).toHaveAttribute("data-preview-step", "1");
  await expect(preview.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Meet your agents" }).click();
  await expect(preview).toHaveAttribute("data-preview-step", "2");
  await preview.getByRole("button", { name: "See what’s next" }).click();
  await expect(preview.getByText("Invited by Alex")).toBeVisible();
  await preview.getByRole("button", { name: "Accept invitation" }).click();
  await page.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("redirect") === destination);
  expect(claims).toBe(0);
});

test("large text and long invite names remain readable with reachable actions", async ({
  page,
}) => {
  const longName = "Our family and friends across every part of the world";
  await page.route("**/api/one/location/circle-codes/public-preview", (route) =>
    route.fulfill({
      json: {
        circle: { name: longName, ownerDisplayName: "Alexandra Elizabeth" },
      },
    }),
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(ROUTE);
  const preview = page.getByTestId("guest-preview");
  await preview.getByRole("button", { name: "Meet your agents" }).click();
  await preview.getByRole("button", { name: "See what’s next" }).click();
  await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
  const title = preview.getByRole("heading", { name: longName, exact: true });
  await expect(title).toBeVisible();
  expect(
    await title.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth + 1,
      ellipsis: getComputedStyle(el).textOverflow,
    })),
  ).toEqual({ clipped: false, ellipsis: "clip" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const cta = preview.getByRole("button", {
    name: "Join this Circle",
    exact: true,
  });
  // At 200% text, accessible scrolling takes precedence over viewport fitting.
  await cta.scrollIntoViewIfNeeded();
  await expectHittable(cta);
});
