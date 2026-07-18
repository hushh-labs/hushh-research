import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("timeout config", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("treats zero consent timeout as immediate", async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.NEXT_PUBLIC_CONSENT_TIMEOUT_SECONDS = "0";
    vi.resetModules();

    const { API_TIMEOUTS, CONSENT_TIMEOUT_MS, CONSENT_TIMEOUT_SECONDS } =
      await import("@/lib/constants");

    expect(CONSENT_TIMEOUT_SECONDS).toBe(0);
    expect(CONSENT_TIMEOUT_MS).toBe(0);
    expect(API_TIMEOUTS.CONSENT_WAIT).toBe(0);
  });
});
