// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apps: [] as any[], credential: "", authCredential: "", file: "", exists: false,
  initialize: vi.fn((options: any) => ({ options })),
  adc: vi.fn(() => ({})), cert: vi.fn((value: any) => ({ projectId: value.project_id })),
}));
vi.mock("firebase-admin", () => ({
  apps: state.apps, initializeApp: state.initialize,
  credential: { cert: state.cert, applicationDefault: state.adc }, auth: () => ({}),
}));
vi.mock("fs", () => ({ existsSync: () => state.exists, readFileSync: () => state.file }));
vi.mock("@/lib/runtime/settings", () => ({
  FIREBASE_ADMIN_CREDENTIALS_JSON_ENV: "FIREBASE_ADMIN_CREDENTIALS_JSON",
  resolveServerFirebaseAdminCredentialsJson: () => state.credential,
  resolveServerFirebaseAuthCredentialsJson: () => state.authCredential,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.apps.length = 0;
  state.credential = "";
  state.authCredential = "";
  state.file = "";
  state.exists = false;
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "hushh-pda");
  vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

const credential = (project: string) => JSON.stringify({ project_id: project, client_email: "fixture@example.invalid", private_key: "synthetic-only" });
const load = () => import("@/lib/firebase/admin");

describe("Firebase server identity authority", () => {
  it("checks configured credentials before reusing a valid named app", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "hushh-pda-dev");
    state.apps.push({ name: "hushh-auth", options: { projectId: "hushh-pda-dev" } });
    state.authCredential = credential("hushh-pda");
    await expect(load().then(() => true)).rejects.toThrow(/mismatch/);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("selects isolated Auth through ADC without reusing messaging credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "hushh-pda-dev");
    state.credential = credential("hushh-pda");
    state.apps.push({ name: "[DEFAULT]", options: { projectId: "hushh-pda" } });
    await load();
    expect(state.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "hushh-pda-dev" }), "hushh-auth",
    );
    expect(state.adc).toHaveBeenCalledOnce();
    expect(state.cert).not.toHaveBeenCalled();
  });
  it("refuses foreign isolated credentials without falling back", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "hushh-pda-dev");
    state.authCredential = credential("hushh-pda");
    await expect(load()).rejects.toThrow(/mismatch/);
    expect(state.adc).not.toHaveBeenCalled();
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("refuses an existing named Auth app from another project", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_FIREBASE_PROJECT_ID", "hushh-pda-dev");
    state.apps.push({ name: "hushh-auth", options: { projectId: "hushh-pda" } });
    await expect(load()).rejects.toThrow(/mismatch/);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("preserves the selected production project", async () => {
    state.credential = credential("hushh-pda");
    await load();
    expect(state.initialize).toHaveBeenCalledWith(expect.objectContaining({ projectId: "hushh-pda" }));
    expect(state.adc).not.toHaveBeenCalled();
  });
  it("rejects a wrong credential file instead of falling through to env/ADC", async () => {
    state.exists = true;
    state.file = credential("hushh-pda-uat");
    state.credential = credential("hushh-pda");
    await expect(load()).rejects.toThrow(/mismatched/);
    expect(state.initialize).not.toHaveBeenCalled();
    expect(state.adc).not.toHaveBeenCalled();
  });
  it("rejects invalid or wrong environment credentials without fallback", async () => {
    state.credential = credential("hushh-pda-uat");
    await expect(load()).rejects.toThrow(/mismatched/);
    expect(state.adc).not.toHaveBeenCalled();
  });
  it("does not adopt a reused default app for another realm", async () => {
    state.apps.push({ options: { projectId: "hushh-pda-uat" } });
    await expect(load()).rejects.toThrow(/mismatch/);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("refuses an implicit production fallback when identity is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "");
    await expect(load()).rejects.toThrow(/explicit client/);
    expect(state.adc).not.toHaveBeenCalled();
  });
});
