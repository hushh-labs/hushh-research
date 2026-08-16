import { expect, test, type Page } from "@playwright/test";

/**
 * Responsive integrity contract for the Circle invite landing.
 *
 * This exists because the screen shipped broken in a way no unit test could
 * see and no screenshot review reliably catches: `/circle/join` renders inside
 * the signed-in shell, which already reserves the top bar (a spacer sized to
 * `--app-top-content-offset`) and the bottom composer (`--app-scroll-bottom-pad`).
 * The page also asked for `min-h-[100svh]` and centred its column inside that,
 * double-counting the reservation -- 154px of dead scroll at every width, with
 * the invitation pushed under the header.
 *
 * The assertions below are geometric and hit-tested, not visual. A passing run
 * captures no screenshots and needs no human comparison; Playwright keeps a
 * screenshot only when one of these fails.
 *
 * The route is public, so this needs no reviewer fixture.
 */

const ROUTE = "/circle/join?code=SWDX-ENDP-B954";

// The compact widths the product supports, plus one wide reference and one
// short viewport (the final action must stay reachable on a short phone).
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x640", width: 360, height: 640 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "390x600-short", width: 390, height: 600 },
  { name: "768x1024", width: 768, height: 1024 },
] as const;

/** Minimum comfortable touch target for this touch-first product. */
const MIN_TOUCH_TARGET = 44;

interface ContractProbe {
  reservedTopBand: number;
  contentTop: number;
  scrollRootScrollHeight: number;
  scrollRootClientHeight: number;
  documentOverflowX: number;
  title: {
    text: string;
    textOverflow: string;
    webkitLineClamp: string;
    scrollWidth: number;
    clientWidth: number;
    right: number;
  } | null;
  code: { scrollWidth: number; clientWidth: number; right: number } | null;
  cta: {
    text: string;
    height: number;
    width: number;
    top: number;
    bottom: number;
  } | null;
  widestRight: number;
  viewportWidth: number;
}

/**
 * Understood, documented noise -- kept deliberately narrow.
 *
 * The app's viewport meta declares `interactive-widget`, which Chromium honours
 * and WebKit does not yet recognise. WebKit logs it at error level on every
 * page load. It is a capability gap in the engine, not a fault on this screen,
 * and it is emitted by the shared root layout rather than anything here.
 */
const ALLOWED_CONSOLE_NOISE = [/Viewport argument key .* not recognized/i];

/**
 * RES-012 — a layout contract that ignores runtime health can pass on a screen
 * that is throwing. Every test in this file watches the page.
 */
function watchRuntime(page: Page): string[] {
  const errors: string[] = [];
  const keep = (text: string) =>
    !ALLOWED_CONSOLE_NOISE.some((pattern) => pattern.test(text));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (keep(text)) errors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => {
    if (keep(error.message)) errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function probe(page: Page): Promise<ContractProbe> {
  return page.evaluate(() => {
    // Resolve a CSS length token to pixels without guessing at its value.
    const resolvePx = (expression: string): number => {
      const probeEl = document.createElement("div");
      probeEl.style.position = "absolute";
      probeEl.style.visibility = "hidden";
      probeEl.style.height = expression;
      document.body.appendChild(probeEl);
      const height = probeEl.getBoundingClientRect().height;
      probeEl.remove();
      return height;
    };

    const scrollRoot = document.querySelector<HTMLElement>(
      '[data-app-scroll-root="true"]',
    );
    const pageRoot =
      document.querySelector<HTMLElement>(
        '[data-testid="circle-join-landing"]',
      ) ?? document.querySelector<HTMLElement>("main");
    const header =
      document.querySelector<HTMLElement>(
        '[data-testid="circle-join-header"]',
      ) ?? pageRoot;
    const titleEl = pageRoot?.querySelector<HTMLElement>("h1") ?? null;
    const codeEl = document.querySelector<HTMLElement>(
      '[data-testid="circle-join-code"]',
    );
    const ctaEl =
      document.querySelector<HTMLElement>(
        '[data-testid="circle-join-sign-in"]',
      ) ??
      document.querySelector<HTMLElement>(
        '[data-testid="circle-join-continue"]',
      );

    // The widest painted edge anywhere in the page subtree, for overflow.
    let widestRight = 0;
    if (pageRoot) {
      for (const el of Array.from(pageRoot.querySelectorAll("*"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) widestRight = Math.max(widestRight, rect.right);
      }
    }

    const measureText = (el: HTMLElement | null) => {
      if (!el) return null;
      const styles = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? "").trim(),
        textOverflow: styles.textOverflow,
        webkitLineClamp: styles.webkitLineClamp,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: rect.right,
      };
    };

    const titleMeasured = measureText(titleEl);
    const codeMeasured = measureText(codeEl);

    return {
      reservedTopBand: resolvePx("var(--top-shell-reserved-height)"),
      contentTop: header ? header.getBoundingClientRect().top : Number.NaN,
      scrollRootScrollHeight: scrollRoot?.scrollHeight ?? 0,
      scrollRootClientHeight: scrollRoot?.clientHeight ?? 0,
      documentOverflowX:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      title: titleMeasured,
      code: codeMeasured
        ? {
            scrollWidth: codeMeasured.scrollWidth,
            clientWidth: codeMeasured.clientWidth,
            right: codeMeasured.right,
          }
        : null,
      cta: ctaEl
        ? {
            text: (ctaEl.textContent ?? "").trim(),
            height: ctaEl.getBoundingClientRect().height,
            width: ctaEl.getBoundingClientRect().width,
            top: ctaEl.getBoundingClientRect().top,
            bottom: ctaEl.getBoundingClientRect().bottom,
          }
        : null,
      widestRight: Math.round(widestRight),
      viewportWidth: window.innerWidth,
    };
  });
}

test.describe("Circle invite landing — responsive contract", () => {
  for (const viewport of VIEWPORTS) {
    test(`holds its contracts at ${viewport.name}`, async ({ page }) => {
      const runtimeErrors = watchRuntime(page);
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(ROUTE, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="circle-join-code"]');

      const measured = await probe(page);

      // Contract E — the invitation begins below the reserved top-bar band.
      // The shell owns that reservation; the page must not paint into it.
      expect(
        measured.contentTop,
        `content must start below the ${measured.reservedTopBand}px top-bar band`,
      ).toBeGreaterThanOrEqual(measured.reservedTopBand);

      // Contract A — the product-owned title is complete, never ellipsized.
      expect(measured.title, "the page must render an h1").not.toBeNull();
      expect(measured.title!.text.length).toBeGreaterThan(0);
      expect(measured.title!.textOverflow).not.toBe("ellipsis");
      expect(measured.title!.webkitLineClamp).toBe("none");
      expect(
        measured.title!.scrollWidth,
        "title is horizontally clipped",
      ).toBeLessThanOrEqual(measured.title!.clientWidth + 1);
      expect(measured.title!.right).toBeLessThanOrEqual(viewport.width + 1);

      // Contract G — the invite code is a single unbroken token; it must wrap
      // rather than run past the edge at 320px.
      expect(measured.code, "the invite code must render").not.toBeNull();
      expect(measured.code!.scrollWidth).toBeLessThanOrEqual(
        measured.code!.clientWidth + 1,
      );
      expect(measured.code!.right).toBeLessThanOrEqual(viewport.width + 1);

      // Contract D — no accidental horizontal overflow, page or document.
      expect(measured.documentOverflowX).toBeLessThanOrEqual(1);
      expect(
        measured.widestRight,
        "an element paints past the viewport",
      ).toBeLessThanOrEqual(measured.viewportWidth + 1);

      // Contract H — the primary action keeps a usable target.
      expect(measured.cta, "the primary action must render").not.toBeNull();
      expect(measured.cta!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

      // RES-012 — the screen must not be throwing while it looks correct.
      expect(runtimeErrors).toEqual([]);
    });
  }

  test("adds no dead scroll at a standard phone height", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROUTE, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="circle-join-code"]');

    const measured = await probe(page);
    const deadScroll =
      measured.scrollRootScrollHeight - measured.scrollRootClientHeight;

    // The regression this file exists for: the screen forced ~154px of scroll
    // with barely a screen of content in it, because it asked for a viewport
    // height on top of the shell's own reservation.
    expect(
      deadScroll,
      "a screen this short must not scroll at all",
    ).toBeLessThanOrEqual(1);
  });

  test("keeps the primary action clear of the fixed bottom chrome", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ROUTE, { waitUntil: "networkidle" });
    const cta = page.getByTestId("circle-join-sign-in");
    await cta.waitFor();
    await cta.scrollIntoViewIfNeeded();

    // Contract F, by hit-testing rather than by measuring the composer: the
    // element at the action's own centre must be the action itself.
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest("[data-testid]")?.getAttribute("data-testid") ?? null : null;
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hit, "the bottom chrome is covering the primary action").toBe(
      "circle-join-sign-in",
    );
  });

  test("never paints above the persistent header while scrolling", async ({
    page,
  }) => {
    // A short viewport at large text guarantees a column taller than the
    // screen, so there is real scrolling to test.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(ROUTE, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="circle-join-code"]');

    // Approximate a 200% text setting, then wait for the root font size to
    // actually apply -- an observable state, not a delay.
    await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
    await expect
      .poll(async () =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .toBe("32px");

    // Scroll to the end and wait for the position to settle, rather than
    // sleeping. A fixed delay is a race, not a synchronisation primitive.
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-app-scroll-root="true"]',
      );
      if (root) root.scrollTop = root.scrollHeight;
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(
            '[data-app-scroll-root="true"]',
          );
          if (!root) return -1;
          return Math.round(
            root.scrollHeight - root.clientHeight - root.scrollTop,
          );
        }),
      )
      .toBeLessThanOrEqual(1);

    // Contract E — paint order, not pointer order.
    //
    // The top chrome's mask is deliberately `pointer-events-none` so a finger
    // dragged across it still scrolls the page beneath. `elementFromPoint`
    // skips such elements, so hit-testing the band would report the content
    // underneath and prove nothing about what is drawn on top. The honest
    // assertions are: the header sits in a higher layer than the scroll root,
    // and its own controls stay hittable at their own coordinates.
    const layers = await page.evaluate(() => {
      const scrollRoot = document.querySelector<HTMLElement>(
        '[data-app-scroll-root="true"]',
      );
      const topBar = document.querySelector<HTMLElement>(
        '[data-testid="top-app-bar-header"]',
      );
      const readZ = (el: HTMLElement | null): number => {
        if (!el) return Number.NaN;
        // Walk up until a positioned ancestor declares a z-index.
        let node: HTMLElement | null = el;
        while (node) {
          const z = getComputedStyle(node).zIndex;
          if (z !== "auto") return Number(z);
          node = node.parentElement;
        }
        return 0;
      };
      return {
        headerPresent: Boolean(topBar),
        headerZ: readZ(topBar),
        scrollRootZ: readZ(scrollRoot),
        headerPosition: topBar ? getComputedStyle(topBar).position : null,
      };
    });

    expect(layers.headerPresent, "the persistent header must be mounted").toBe(
      true,
    );
    expect(
      layers.headerZ,
      "page content outranks the persistent header",
    ).toBeGreaterThan(layers.scrollRootZ);

    // And the header's own controls remain hittable after scrolling.
    const controlsHittable = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>(
        '[data-testid="top-app-bar-actions"]',
      );
      if (!actions) return "no-actions-slot";
      const rect = actions.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return "actions-collapsed";
      const el = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const landing =
        document.querySelector('[data-testid="circle-join-landing"]') ??
        document.querySelector("main");
      return el && landing && landing.contains(el)
        ? "covered-by-page-content"
        : "hittable";
    });

    expect(
      controlsHittable,
      "page content is covering the header's controls",
    ).not.toBe("covered-by-page-content");
  });
});
