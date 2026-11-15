import { describe, expect, it, vi } from "vitest";
import { areScheduledTasksAvailable, PodScheduledTasksClient } from "@/lib/services/pod-scheduled-tasks";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { resolveAppEnvironment } from "@/lib/app-env";

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
const api = vi.hoisted(() => ({ getComputerUseAdmission: vi.fn(), ownerPodRequest: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: api }));

describe("Scheduled tasks environment admission", () => {
  beforeEach(() => {
    publishValidatedAuthSessionOwner("owner");
    api.getComputerUseAdmission.mockReset();
    api.ownerPodRequest.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());
  it("refuses every production schedule operation before admission or transport", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    const client = new PodScheduledTasksClient("owner");
    const task = { id: "schedule_" + "a".repeat(32), revision: 1 } as Parameters<typeof client.control>[0];
    for (const result of [client.status(), client.control(task, "pause"),
      client.control(task, "resume"), client.control(task, "cancel"),
      client.organizeFile({ id: "b".repeat(32), name: "test" }, 2000, "request-id")]) {
      await expect(result).rejects.toThrow("SCHEDULE_UNAVAILABLE");
    }
    expect(api.getComputerUseAdmission).not.toHaveBeenCalled();
    expect(api.ownerPodRequest).not.toHaveBeenCalled();
  });

  it.each(["dev", "development", "uat", "staging"])("preserves %s scheduling in optimized builds", async (environment) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment);
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod" });
    api.ownerPodRequest.mockResolvedValue(Response.json({ available: false, code: "SCHEDULE_AUTHORITY_UNAVAILABLE",
      authorization_limit_at: null, templates: [], tasks: [] }));
    expect(areScheduledTasksAvailable()).toBe(true);
    await expect(new PodScheduledTasksClient("owner").status()).resolves.toMatchObject({ available: false });
    expect(api.ownerPodRequest).toHaveBeenCalledOnce();
  });

});
