import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppEnvironment } from "@/lib/app-env";

describe("compliance config environment", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("normalizes whitespace around app env", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "  production  ";

    expect(resolveAppEnvironment()).toBe("production");
  });
});
