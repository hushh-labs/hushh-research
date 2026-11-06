// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ apps: [] as any[], getAuth: vi.fn() }));
vi.mock("firebase/app", () => ({
  getApps: () => state.apps,
  getApp: () => state.apps.find(app => app.name === "[DEFAULT]"),
  initializeApp: (options: unknown, name = "[DEFAULT]") => {
    const app = { options, name }; state.apps.push(app); return app;
  },
}));
vi.mock("firebase/auth", () => ({
  getAuth: state.getAuth,
  RecaptchaVerifier: class {},
}));
vi.mock("@/lib/observability/env", () => ({ resolveAnalyticsMeasurementId: () => "" }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); state.apps.length = 0;
  state.getAuth.mockImplementation(app => ({ app, settings: {} }));
  for (const [key, value] of Object.entries({
    API_KEY: "primary-key", AUTH_DOMAIN: "hushh-pda.firebaseapp.com",
    PROJECT_ID: "hushh-pda", APP_ID: "primary-app",
  })) vi.stubEnv(`NEXT_PUBLIC_FIREBASE_${key}`, value);
  for (const key of ["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "APP_ID"])
    vi.stubEnv(`NEXT_PUBLIC_AUTH_FIREBASE_${key}`, "");
});
afterEach(() => vi.unstubAllEnvs());

function selectDev() {
  for (const [key, value] of Object.entries({
    API_KEY: "dev-key", AUTH_DOMAIN: "hushh-pda-dev.firebaseapp.com",
    PROJECT_ID: "hushh-pda-dev", APP_ID: "dev-app",
  })) vi.stubEnv(`NEXT_PUBLIC_AUTH_FIREBASE_${key}`, value);
}

describe("client Firebase authority", () => {
  it("keeps existing users on the default app when no migration is selected", async () => {
    const { app, auth } = await import("@/lib/firebase/config");
    expect(auth.app).toBe(app);
    expect(state.apps).toHaveLength(1);
  });
  it("isolates Auth while keeping the original push/analytics app", async () => {
    selectDev();
    const { app, auth } = await import("@/lib/firebase/config");
    expect(app.options.projectId).toBe("hushh-pda");
    expect(auth.app.name).toBe("hushh-auth");
    expect(auth.app.options.projectId).toBe("hushh-pda-dev");
    expect(auth.app.options.apiKey).toBe("dev-key");
  });
  it("refuses partial selection rather than combining two projects", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "hushh-pda-dev");
    await expect(import("@/lib/firebase/config")).rejects.toThrow(/complete configuration/);
    expect(state.getAuth).not.toHaveBeenCalled();
  });
  it("refuses a cached Auth app with the right name and foreign identity", async () => {
    selectDev();
    state.apps.push({ name: "[DEFAULT]", options: { projectId: "hushh-pda" } },
      { name: "hushh-auth", options: { projectId: "hushh-pda", apiKey: "foreign" } });
    await expect(import("@/lib/firebase/config")).rejects.toThrow(/authority mismatch/);
    expect(state.getAuth).not.toHaveBeenCalled();
  });
});
