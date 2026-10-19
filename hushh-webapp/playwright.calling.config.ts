import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /direct-calls\.realtime\.spec\.ts/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
