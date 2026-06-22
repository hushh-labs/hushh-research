import { afterEach, describe, expect, it, vi } from "vitest";

describe("env-utils", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("normalises uppercase UAT env alias", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "UAT";

    const { resolveAppEnvironment } = await import("@/lib/app-env");

    expect(resolveAppEnvironment()).toBe("uat");
  });
});
