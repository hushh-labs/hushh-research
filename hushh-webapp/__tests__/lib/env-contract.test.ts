import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Environment contract test.
 *
 * Verifies that .env.example documents every environment variable key
 * the application depends on. Prevents silent misconfigurations when
 * required env vars are added without updating the canonical example file.
 *
 * Pattern: static source file inspection — no app code imported,
 * no runtime env values read. Mirrors register-phone-shell-contract pattern.
 */
describe("environment contract (.env.example)", () => {
  const envExample = readFileSync(
    join(process.cwd(), ".env.example"),
    "utf8"
  );

  // ── Firebase ────────────────────────────────────────────────────────────────

  const REQUIRED_FIREBASE_KEYS = [
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
  ] as const;

  it("documents all required Firebase env var keys", () => {
    for (const key of REQUIRED_FIREBASE_KEYS) {
      expect(envExample, `Missing Firebase key: ${key}`).toContain(key);
    }
  });

  // ── Runtime / Build ─────────────────────────────────────────────────────────

  const REQUIRED_RUNTIME_KEYS = [
    "NEXT_PUBLIC_APP_ENV",
    "NEXT_PUBLIC_CLIENT_VERSION",
    "APP_RUNTIME_PROFILE",
    "NEXT_PUBLIC_BACKEND_URL",
    "NEXT_PUBLIC_APP_URL",
  ] as const;

  it("documents all required runtime env var keys", () => {
    for (const key of REQUIRED_RUNTIME_KEYS) {
      expect(envExample, `Missing runtime key: ${key}`).toContain(key);
    }
  });

  // ── Observability ────────────────────────────────────────────────────────────

  const REQUIRED_OBSERVABILITY_KEYS = [
    "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
    "NEXT_PUBLIC_OBSERVABILITY_DEBUG",
    "NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE",
    "NEXT_PUBLIC_GTM_ID",
  ] as const;

  it("documents all required observability env var keys", () => {
    for (const key of REQUIRED_OBSERVABILITY_KEYS) {
      expect(envExample, `Missing observability key: ${key}`).toContain(key);
    }
  });

  // ── Default value contracts ──────────────────────────────────────────────────

  it("declares APP_RUNTIME_PROFILE default as local", () => {
    expect(envExample).toContain("APP_RUNTIME_PROFILE=local");
  });

  it("declares NEXT_PUBLIC_APP_ENV default as development", () => {
    expect(envExample).toContain("NEXT_PUBLIC_APP_ENV=development");
  });

  it("declares NEXT_PUBLIC_OBSERVABILITY_ENABLED default as true", () => {
    expect(envExample).toContain("NEXT_PUBLIC_OBSERVABILITY_ENABLED=true");
  });

  it("declares NEXT_PUBLIC_OBSERVABILITY_DEBUG default as false", () => {
    expect(envExample).toContain("NEXT_PUBLIC_OBSERVABILITY_DEBUG=false");
  });

  it("declares NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE default as 1", () => {
    expect(envExample).toContain("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE=1");
  });
});