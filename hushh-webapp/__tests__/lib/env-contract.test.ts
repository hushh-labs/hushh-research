import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/app-env", () => ({
  resolveAppEnvironment: vi.fn(),
}));

vi.mock("@/lib/runtime/settings", () => ({
  resolveRuntimeBackendUrl: vi.fn(),
  resolveRuntimeFrontendUrl: vi.fn(),
}));

describe("env contract", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps production fallback empty when runtime urls are missing", async () => {
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    const { resolveRuntimeBackendUrl, resolveRuntimeFrontendUrl } =
      await import("@/lib/runtime/settings");

    vi.mocked(resolveAppEnvironment).mockReturnValue("production");
    vi.mocked(resolveRuntimeBackendUrl).mockReturnValue("");
    vi.mocked(resolveRuntimeFrontendUrl).mockReturnValue("");

    const config = await import("@/lib/config");

    expect(config.BACKEND_URL).toBe("");
    expect(config.APP_FRONTEND_ORIGIN).toBe("");
  });
});
