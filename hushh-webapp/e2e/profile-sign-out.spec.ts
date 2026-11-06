import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  hasReviewerSession,
  openReviewerSession,
} from "./helpers/reviewer-session";

let script: string;
test.beforeAll(async () => {
  const { build } = await import("vite");
  const root = process.cwd();
  const boundary = path.join(root, "e2e/fixtures/profile-sign-out-boundaries.ts");
  const modules = [
    "firebase/auth", "@capacitor/core", "@/lib/firebase/config",
    "@/lib/services/auth-service", "@/lib/services/api-service",
    "@/lib/notifications/fcm-service", "@/lib/services/account-identity-service",
    "@/lib/cache/cache-sync-service", "@/lib/services/user-local-state-service",
    "@/lib/services/onboarding-local-service", "@/lib/services/onboarding-route-cookie",
    "@/lib/utils/session-storage", "@/lib/observability/identity",
    "@/lib/connected-systems/crm-product-availability", "@/lib/capacitor/session-privacy",
    "@/lib/interaction/interaction-intent-coordinator", "@/lib/agent/one-conversation-session",
  ];
  const result = await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic", development: false } },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    resolve: { alias: [
      { find: /^\.\/config$/, replacement: boundary },
      ...modules.map((id) => ({ find: id, replacement: boundary })),
      { find: path.join(root, "lib/firebase/config"), replacement: boundary },
      { find: "@", replacement: root },
    ] },
    build: {
      write: false,
      lib: { entry: path.join(root, "e2e/fixtures/profile-sign-out.tsx"), formats: ["iife"], name: "SignOutFixture" },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  script = outputs.flatMap((output) => "output" in output ? output.output : [])
    .filter((chunk) => chunk.type === "chunk").map((chunk) => chunk.code).join("\n");
});

test("profile sign-out replaces the document without refresh despite stalled notifications", async ({ page }) => {
  const events: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("recordSignOutEvent", (event: string) => { events.push(event); });
  await page.route("https://sign-out.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      events.push("home-document");
      // A server-rendered home document is not instant; the old page must
      // stay gated while it loads instead of re-rendering as signed out.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ contentType: "text/html", body: "<h1>Welcome</h1>" });
    } else {
      await route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script>${script}</script>` });
    }
  });
  await page.goto("https://sign-out.test/one/profile");
  await expect.poll(async () => errors.length ? errors.join("\n") : page.locator("main p").textContent()).toBe("Connected");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL("https://sign-out.test/", { timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  for (const event of ["notification-cleanup-started", "credentials-cleared", "cookie-cleared", "local-state-cleared", "intro-requested"]) {
    expect(events.indexOf(event)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(event)).toBeLessThan(events.indexOf("home-document"));
  }
  await expect(page.getByRole("heading", { name: "Profile" })).toHaveCount(0);
  expect(events).not.toContain("guard-login-redirect");
});

test(
  "real profile sign-out clears the browser session cookie",
  async ({ page, browserName }) => {
    test.skip(
      !hasReviewerSession(),
      "requires the environment-wired reviewer and E2E_REVIEWER_SIGNIN=1",
    );
    test.skip(
      browserName !== "chromium",
      "real reviewer sign-out proof runs in Chromium",
    );
    test.setTimeout(180_000);

    await openReviewerSession(
      page,
      {
        userId: process.env.REVIEWER_UID?.trim() ?? "",
        passphrase: process.env.REVIEWER_VAULT_PASSPHRASE ?? "",
      },
      { redirectTo: "/one?profile_pane=1", readyHeading: null },
    );

    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/one" &&
        url.searchParams.get("profile_pane") === "1",
    );
    const profile = page.getByTestId("profile-primary");
    await expect(profile).toBeVisible({ timeout: 60_000 });
    const signOut = profile.getByRole("button", {
      name: "Sign out",
      exact: true,
    });
    await expect(signOut).toBeVisible();

    const sessionDelete = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/auth/session"
      );
    });
    await signOut.click();

    const deletedSession = await sessionDelete;
    expect(deletedSession.status()).toBe(200);
    await expect(page).toHaveURL((url) => url.pathname === "/", {
      timeout: 45_000,
    });

    const sessionStatus = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      return {
        status: response.status,
        body: await response.json(),
      };
    });
    expect(sessionStatus).toEqual({
      status: 401,
      body: { authenticated: false },
    });
    await expect(page.getByTestId("profile-primary")).toHaveCount(0);
  },
);
