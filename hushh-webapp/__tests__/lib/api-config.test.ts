import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("API_CONFIG", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses development base url fallback when backend env is undefined", async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    vi.resetModules();

    const { API_CONFIG } = await import("@/lib/constants");

    expect(API_CONFIG.BASE_URL).toBe("http://127.0.0.1:8000");
  });
});
