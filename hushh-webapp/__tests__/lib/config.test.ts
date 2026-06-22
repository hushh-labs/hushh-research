import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/app-env", () => ({
  resolveAppEnvironment: vi.fn(),
}));

vi.mock("@/lib/runtime/settings", () => ({
  resolveRuntimeBackendUrl: vi.fn(),
  resolveRuntimeFrontendUrl: vi.fn(),
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports development mode correctly", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");

    const config = await import("@/lib/config");

    expect(config.isDevelopment()).toBe(true);
    expect(config.isProduction()).toBe(false);
  });

  it("reports production mode correctly", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");

    const config = await import("@/lib/config");

    expect(config.isDevelopment()).toBe(false);
    expect(config.isProduction()).toBe(true);
  });

  it("uses development backend fallback when runtime backend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("http://127.0.0.1:8000");
  });
  it("uses development backend fallback when runtime backend url is whitespace only", async () => {
  const { resolveAppEnvironment } = await import("@/lib/app-env");
  const { resolveRuntimeBackendUrl } = await import(
    "@/lib/runtime/settings"
  );

  vi.mocked(resolveAppEnvironment).mockReturnValue("development");
  vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("   ");

  const config = await import("@/lib/config");

  expect(config.BACKEND_URL).toBe("http://127.0.0.1:8000");
 });
 it("uses development frontend fallback when runtime frontend url is whitespace only", async () => {
  const { resolveAppEnvironment } = await import("@/lib/app-env");
  const { resolveRuntimeFrontendUrl } = await import(
    "@/lib/runtime/settings"
  );

  vi.mocked(resolveAppEnvironment).mockReturnValue("development");
  vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("   ");

  const config = await import("@/lib/config");

  expect(config.APP_FRONTEND_ORIGIN).toBe("http://localhost:3000");
 });

  it("resolves configured development backend url", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue(
      " http://localhost:8000/ "
    );

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("http://localhost:8000");
  });

  it("uses development frontend fallback when runtime frontend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeFrontendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("development");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.APP_FRONTEND_ORIGIN).toBe("http://localhost:3000");
  });

  it("resolves production frontend origin to the production domain", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeFrontendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue(
      "https://kai.hushh.ai/"
    );

    const config = await import("@/lib/config");

    expect(config.APP_FRONTEND_ORIGIN).toBe("https://kai.hushh.ai");
  });

  it("keeps production backend empty when runtime backend url is empty", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("");
  });

  it("resolves UAT backend url from runtime settings", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("uat");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue(
      "https://uat-api.hushh.ai/",
    );

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("https://uat-api.hushh.ai");
  });

  it("uses runtime frontend origin in production environment", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeFrontendUrl } = await import(
      "@/lib/runtime/settings"
    );

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue(
      "https://app.hushh.ai/"
    );

    const config = await import("@/lib/config");

    expect(config.APP_FRONTEND_ORIGIN).toBe("https://app.hushh.ai");
  });

  it("treats empty string app env as development", async () => {
    const originalAppEnv = process.env.NEXT_PUBLIC_APP_ENV;
    const originalObservabilityEnv = process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;
    const originalEnvironmentMode = process.env.NEXT_PUBLIC_ENVIRONMENT_MODE;
    const originalNodeEnv = process.env.NODE_ENV;

    vi.doUnmock("@/lib/app-env");
    vi.resetModules();

    process.env.NEXT_PUBLIC_APP_ENV = "";
    delete process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;
    delete process.env.NEXT_PUBLIC_ENVIRONMENT_MODE;
    process.env.NODE_ENV = "development";

    const { resolveRuntimeBackendUrl, resolveRuntimeFrontendUrl } =
      await import("@/lib/runtime/settings");

    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.ENVIRONMENT_MODE).toBe("development");
    expect(config.BACKEND_URL).toBe("http://127.0.0.1:8000");
    expect(config.APP_FRONTEND_ORIGIN).toBe("http://localhost:3000");

    if (originalAppEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_ENV;
    } else {
      process.env.NEXT_PUBLIC_APP_ENV = originalAppEnv;
    }
    if (originalObservabilityEnv === undefined) {
      delete process.env.NEXT_PUBLIC_OBSERVABILITY_ENV;
    } else {
      process.env.NEXT_PUBLIC_OBSERVABILITY_ENV = originalObservabilityEnv;
    }
    if (originalEnvironmentMode === undefined) {
      delete process.env.NEXT_PUBLIC_ENVIRONMENT_MODE;
    } else {
      process.env.NEXT_PUBLIC_ENVIRONMENT_MODE = originalEnvironmentMode;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
