import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // This standalone rehearsal owns its database, emulator and relay lifecycle.
  // Its name stays outside the shared config's default spec/test discovery.
  testMatch: /direct-calls\.realtime\.ts$/,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
