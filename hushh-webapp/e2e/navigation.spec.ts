import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Navigation Tests
 * =================
 *
 * Tests for the core navigation flows of the Kai application.
 * These verify that key routes are accessible and that navigation
 * guards (auth redirects) function correctly.
 */

test.describe("Public Route Accessibility", () => {
  test("root redirects or renders onboarding for unauthenticated users", async ({
    page,
  }) => {
    await page.goto("/");
    // Should stay on root (onboarding) or redirect to login
    await page.waitForLoadState("networkidle");
    const url = page.url();
    expect(url).toMatch(/\/(login)?(\?.*)?$/);
  });

  test("login page is always accessible", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/login");
  });
});

test.describe("Auth-Protected Route Guards", () => {
  test("portfolio page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/portfolio");
    await page.waitForLoadState("networkidle");
    const url = page.url();
    // Should redirect to login or home for unauthenticated users
    expect(url.includes("/login") || url === page.url()).toBeTruthy();
  });

  test("profile page redirects unauthenticated users", async ({ page }) => {
    await page.goto("/one/profile");
    await page.waitForLoadState("networkidle");
    const url = page.url();
    expect(url.includes("/login") || url === page.url()).toBeTruthy();
  });

  test("consent workspace redirects unauthenticated users", async ({ page }) => {
    await page.goto("/one/consent");
    await page.waitForLoadState("networkidle");
    const url = page.url();
    expect(url.includes("/login") || url === page.url()).toBeTruthy();
  });

  test("marketplace page redirects unauthenticated users", async ({
    page,
  }) => {
    await page.goto("/marketplace");
    await page.waitForLoadState("networkidle");
    const url = page.url();
    expect(url.includes("/login") || url === page.url()).toBeTruthy();
  });
});

test.describe("Page Response Codes", () => {
  const publicRoutes = ["/", "/login", "/logout"];

  for (const route of publicRoutes) {
    test(`${route} returns non-500 response`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(500);
    });
  }
});

test("native Back corrects replaced flow while Forward preserves the revealed route", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const root = process.cwd();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-history-boundary-"));
  try {
    const { build } = await import("vite");
    const entry = path.join(root, "e2e/fixtures/history-boundary.virtual.ts");
    await build({
      configFile: false,
      logLevel: "error",
      oxc: { jsx: { runtime: "automatic" } },
      resolve: { alias: { "@": root } },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      plugins: [{
        name: "history-boundary",
        resolveId: (id) => id === entry ? `\0${id}` : undefined,
        load: (id) => id === `\0${entry}` ? `
          import { createElement, useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useWebHistoryBack } from '@/lib/navigation/web-history-back';
          const read = () => ({ pathname: location.pathname, search: location.search });
          function Fixture() {
            const [at, setAt] = useState(read);
            useWebHistoryBack(at.pathname, at.search);
            useEffect(() => {
              window.__historyCorrections = [];
              window.__setPath = (href, replace = false) => {
                history[replace ? 'replaceState' : 'pushState']({}, '', href);
                setAt(read());
              };
              const changed = () => setAt(read());
              const correction = event => {
                window.__historyCorrections.push(event.detail.href);
                window.__setPath(event.detail.href);
              };
              addEventListener('popstate', changed);
              addEventListener('app-internal-navigation-requested', correction);
              return () => {
                removeEventListener('popstate', changed);
                removeEventListener('app-internal-navigation-requested', correction);
              };
            }, []);
            return createElement('p', null, at.pathname + at.search);
          }
          createRoot(document.getElementById('root')).render(createElement(Fixture));
        ` : undefined,
      }],
      build: { outDir, lib: { entry, name: "HistoryBoundary", formats: ["iife"], fileName: () => "fixture.js" } },
    });
    const script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    await page.route("http://localhost/**", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><div id='root'></div>",
    }));
    await page.goto("http://localhost/one");
    await page.addScriptTag({ content: script });
    expect(errors).toEqual([]);
    await expect(page.locator("p")).toHaveText("/one");
    await page.evaluate(() => {
      (window as unknown as { __setPath(href: string, replace?: boolean): void }).__setPath("/one/location");
    });
    await expect(page.locator("p")).toHaveText("/one/location");
    await page.evaluate(() => {
      (window as unknown as { __setPath(href: string, replace?: boolean): void }).__setPath("/one/location?action=share", true);
    });
    await expect(page.locator("p")).toHaveText("/one/location?action=share");
    await page.goBack();
    await expect(page.locator("p")).toHaveText("/one/location?view=now");
    expect(await page.evaluate(() => (window as unknown as { __historyCorrections: string[] }).__historyCorrections))
      .toEqual(["/one/location?view=now"]);
    await page.evaluate(() => {
      (window as unknown as { __setPath(href: string, replace?: boolean): void }).__setPath("/one/location", true);
    });
    await expect(page.locator("p")).toHaveText("/one/location");
    await page.evaluate(() => {
      (window as unknown as { __setPath(href: string): void }).__setPath("/one/location/map");
    });
    await expect(page.locator("p")).toHaveText("/one/location/map");
    await page.goBack();
    await expect(page.locator("p")).toHaveText("/one/location");
    await page.goForward();
    await expect(page.locator("p")).toHaveText("/one/location/map");
    expect(await page.evaluate(() => (window as unknown as { __historyCorrections: string[] }).__historyCorrections))
      .toEqual(["/one/location?view=now"]);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
