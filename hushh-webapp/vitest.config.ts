/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
    globals: true,
    // Locally, several agent worktrees often run the full suite at once; the
    // default (one worker per core) let two concurrent runs put ~30 workers on
    // a 16-core Mac. Cap local runs at half the cores; CI keeps the default.
    maxWorkers: process.env.CI ? undefined : "50%",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.{ts,tsx}", "lib/**/__tests__/**/*.test.{ts,tsx}", "components/**/__tests__/**/*.test.{ts,tsx}", "app/**/__tests__/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        ".next/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/types/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "server-only": path.resolve(__dirname, "./__tests__/mocks/server-only.ts"),
    },
  },
});
