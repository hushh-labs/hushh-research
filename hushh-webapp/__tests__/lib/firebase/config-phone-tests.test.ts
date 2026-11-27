import { afterEach, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ appVerificationDisabledForTesting: false }));
vi.mock("firebase/app", () => ({ getApps: () => [{}], getApp: () => ({}), initializeApp: vi.fn() }));
vi.mock("firebase/auth", () => ({ getAuth: () => ({ settings }), RecaptchaVerifier: vi.fn() }));
vi.mock("@/lib/observability/env", () => ({ resolveAnalyticsMeasurementId: () => undefined }));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each([
  ["development", "hushh-akshat-sandbox-auth", "localhost", "true", true],
  ["development", "hushh-akshat-sandbox-auth", "127.0.0.1", "true", true],
  ["development", "hushh-akshat-sandbox-auth", "[::1]", "true", true],
  ["production", "hushh-akshat-sandbox-auth", "localhost", "true", false],
  ["development", "hushh-pda-uat", "localhost", "true", false],
  ["development", "hushh-akshat-sandbox-auth", "uat.one.hussh.ai", "true", false],
  ["development", "hushh-akshat-sandbox-auth", "localhost", "false", false],
] as const)("admits fictional-phone SDK mode only for an opted-in local sandbox: %s %s %s %s", async (nodeEnv, project, hostname, flag, expected) => {
  vi.resetModules();
  settings.appVerificationDisabledForTesting = false;
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", project);
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION", flag);
  vi.stubGlobal("window", { location: { hostname } });
  await import("@/lib/firebase/config");
  expect(settings.appVerificationDisabledForTesting).toBe(expected);
});
