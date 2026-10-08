// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../scripts/testing/reviewer-test-identity.mjs");
  vi.doUnmock("../../scripts/native/prepare-native-test-artifacts.mjs");
  vi.doUnmock("../../scripts/native/native-ui-audit-plan.mjs");
});

it("keeps the selected dev identity through build and sync without UAT preparation", async () => {
  vi.resetModules();
  process.env = { PATH: originalEnv.PATH, APP_RUNTIME_PROFILE: "dev" };
  const profile = {
    APP_RUNTIME_PROFILE: "dev",
    NEXT_PUBLIC_APP_ENV: "uat",
    NEXT_PUBLIC_BACKEND_URL: "https://dev-backend.example",
    NEXT_PUBLIC_APP_URL: "https://dev-app.example",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "synthetic-dev",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "synthetic-dev.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-public",
    NEXT_PUBLIC_FIREBASE_APP_ID: "synthetic-app",
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123",
  };
  const calls: { command: string; backend: string; profile: string }[] = [];
  vi.doMock("node:child_process", async () => ({
    ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
    execSync: (command: string, options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, backend: options.env.NEXT_PUBLIC_BACKEND_URL!, profile: options.env.APP_RUNTIME_PROFILE! });
    },
  }));
  vi.doMock("node:fs", () => ({ default: {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ audit_plan: { digest: "synthetic-plan" } }),
  } }));
  vi.doMock("../../scripts/testing/reviewer-test-identity.mjs", () => ({
    parseEnvFile: (path: string) => path.endsWith(".env.dev.local") ? profile : {},
  }));
  vi.doMock("../../scripts/native/prepare-native-test-artifacts.mjs", () => ({
    prepareNativeTestArtifacts: () => ({ flows: [] }),
  }));
  vi.doMock("../../scripts/native/native-ui-audit-plan.mjs", () => ({
    createNativeUiAuditPlan: () => ({ digest: "synthetic-plan" }),
  }));
  await import("../../scripts/native/prepare-ios-ui-test-build.mjs");
  expect(calls).toEqual([
    { command: "npm run cap:build", backend: profile.NEXT_PUBLIC_BACKEND_URL, profile: "dev" },
    { command: "npm run cap:sync:ios", backend: profile.NEXT_PUBLIC_BACKEND_URL, profile: "dev" },
  ]);
  expect(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("synthetic-dev");
});
