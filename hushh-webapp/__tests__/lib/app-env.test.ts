import { describe, expect, it, vi } from "vitest";
import { resolveAppEnvironment } from "@/lib/app-env";
import { isObservabilityDebugEnabled } from "@/lib/observability/env";

describe("resolveAppEnvironment", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses NEXT_PUBLIC_APP_ENV when provided", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";

    expect(resolveAppEnvironment()).toBe("development");
  });

  it("maps dev to development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "dev";

    expect(resolveAppEnvironment()).toBe("development");
  });

  it("maps staging to uat", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "staging";

    expect(resolveAppEnvironment()).toBe("uat");
  });

  it("falls back to observability env", () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_OBSERVABILITY_ENV = "uat";

    expect(resolveAppEnvironment()).toBe("uat");
  });

  it("falls back to legacy environment mode", () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;

    process.env.NEXT_PUBLIC_ENVIRONMENT_MODE = "production";

    expect(resolveAppEnvironment()).toBe("production");
  });

  it("defaults to production when NODE_ENV is production", () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;
    delete process.env.NEXT_PUBLIC_ENVIRONMENT_MODE;

    process.env.NODE_ENV = "production";

    expect(resolveAppEnvironment()).toBe("production");
  });

  it("defaults to development when NODE_ENV is not production", () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;
    delete process.env.NEXT_PUBLIC_ENVIRONMENT_MODE;

    process.env.NODE_ENV = "development";

    expect(resolveAppEnvironment()).toBe("development");
  });
});

describe("verbose observability", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["uat", "staging", true],
    ["development", "", true],
    ["production", "production", false],
    ["uat", "production", false],
    ["unknown", "uat", false],
    ["", "uat", false],
  ])("requires a recognised build declaration (%s, %s)", (app, telemetry, enabled) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", app);
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENV", telemetry);
    vi.stubEnv("NEXT_PUBLIC_ENVIRONMENT_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_DEBUG", "true");
    expect(isObservabilityDebugEnabled()).toBe(enabled);
  });
});
