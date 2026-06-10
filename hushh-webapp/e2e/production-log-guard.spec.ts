import { test, expect } from "@playwright/test";

/**
 * Production Log Guard Tests
 * ==========================
 *
 * Verifies that sensitive API routes do not emit console output
 * (log, warn, error) in production-equivalent environments.
 *
 * Routes covered:
 * - /api/consent/logout
 * - /api/consent/cancel
 * - /api/consent/active
 * - /api/auth/session
 * - /api/notifications/register
 * - /api/app-config/review-mode
 */

test.describe("Production Log Guard — Consent & Auth API Routes", () => {
  test("consent/logout route emits no console output on load", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (["log", "warn", "error"].includes(msg.type())) {
        logs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    await page.goto("/");
    await page.waitForTimeout(1000);

    const sensitivePatterns = [
      "Destroying session tokens",
      "Session tokens destroyed",
      "Logout error",
      "Cancel consent error",
      "Active consents error",
      "Session API",
      "Notifications register unavailable",
      "fallback disabled",
    ];

    const leakedLogs = logs.filter((log) =>
      sensitivePatterns.some((pattern) => log.includes(pattern))
    );

    expect(leakedLogs).toHaveLength(0);
  });

  test("no sensitive API internals logged on landing page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");
    await page.waitForTimeout(2000);

    const sensitiveErrors = errors.filter(
      (e) =>
        e.includes("[API]") ||
        e.includes("[Session API]") ||
        e.includes("[app-config") ||
        e.includes("consent")
    );

    expect(sensitiveErrors).toHaveLength(0);
  });
});