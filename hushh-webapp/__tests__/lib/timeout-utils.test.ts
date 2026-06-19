import { describe, expect, it } from "vitest";

describe("timeout-utils", () => {
  it("handles zero timeout values with a safe fallback", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    const { resolveSlowRequestTimeoutMs } = await import("@/lib/utils/request-timeouts");

    expect(resolveSlowRequestTimeoutMs(0)).toBe(75_000);
  });
});
