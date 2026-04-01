import { afterEach, describe, expect, it } from "vitest";

import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

const ORIGINAL_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV;
const ORIGINAL_RUNTIME_PROFILE = process.env.APP_RUNTIME_PROFILE;
const ORIGINAL_OVERRIDE = process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

describe("resolveSlowRequestTimeoutMs", () => {
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_ENV = ORIGINAL_APP_ENV;
    process.env.APP_RUNTIME_PROFILE = ORIGINAL_RUNTIME_PROFILE;
    process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = ORIGINAL_OVERRIDE;
  });

  it("raises slow request timeouts for local development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    delete process.env.APP_RUNTIME_PROFILE;
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(75_000);
  });

  it("keeps production-like runtimes on the provided default", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    delete process.env.APP_RUNTIME_PROFILE;
    delete process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS;

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(20_000);
  });

  it("honors explicit timeout overrides", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    process.env.HUSHH_SLOW_REQUEST_TIMEOUT_MS = "33000";

    expect(resolveSlowRequestTimeoutMs(20_000)).toBe(33_000);
  });
});
