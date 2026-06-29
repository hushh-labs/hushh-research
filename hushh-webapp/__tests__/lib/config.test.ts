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
});