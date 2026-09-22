import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json";

/**
 * Every observability event on every platform was reporting
 * `app_version: "unknown"`. `NEXT_PUBLIC_CLIENT_VERSION` is documented in
 * `.env.example` but was never supplied to a build, and the fallback was the
 * literal string "unknown" -- so the schema was satisfied, the tests passed,
 * and the field carried no information for months.
 *
 * These assert the field is a real version, not merely present.
 */
async function load() {
  vi.resetModules();
  return import("@/lib/observability/client-version");
}

describe("client version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never falls back to the literal 'unknown'", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "");
    const { resolveClientVersion } = await load();
    expect(resolveClientVersion()).not.toBe("unknown");
  });

  it("falls back to the package version when nothing is supplied", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "");
    const { resolveClientVersion } = await load();
    expect(resolveClientVersion()).toBe(packageJson.version);
  });

  it("prefers an explicitly supplied build version", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "2.4.7-rc1");
    const { resolveClientVersion } = await load();
    expect(resolveClientVersion()).toBe("2.4.7-rc1");
  });

  it("ignores a whitespace-only value rather than stamping blanks on events", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "   ");
    const { resolveClientVersion } = await load();
    expect(resolveClientVersion()).toBe(packageJson.version);
  });

  it("resolves to something that looks like a version", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "");
    const { resolveClientVersion } = await load();
    expect(resolveClientVersion()).toMatch(/^\d+\.\d+/);
  });
});
