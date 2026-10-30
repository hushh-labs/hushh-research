/**
 * A development AUTH bypass needs more than a development label.
 *
 * `DEV_AUTO_GRANT`, `Bearer DEV_TOKEN` and the vault routes that skip a failed
 * validation were gated on `isDevelopment()` — "is this build labelled development".
 * That is the right question for a URL default and the wrong one for an auth bypass.
 *
 * The dev backend now reports `ENVIRONMENT=dev`. The moment the frontend follows with
 * `NEXT_PUBLIC_APP_ENV=dev`, `resolveAppEnvironment()` normalises it to `development`
 * and all twelve bypasses would turn on for an internet-reachable service. These pin
 * the door shut before it is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

async function gate(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("@/lib/config");
  return mod.devAuthBypassAllowed();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("a developer machine keeps its bypass", () => {
  it("allows it when the build is development and no deploy lane is set", async () => {
    expect(
      await gate({ NEXT_PUBLIC_APP_ENV: "development", HUSHH_DEPLOY_ENV: undefined }),
    ).toBe(true);
  });
});

describe("no hosted deployment gets it", () => {
  it("refuses on a hosted dev deployment even when the build says development", async () => {
    // The exact future state this exists for: the frontend flipped to report dev.
    expect(
      await gate({ NEXT_PUBLIC_APP_ENV: "dev", HUSHH_DEPLOY_ENV: "dev" }),
    ).toBe(false);
  });

  it.each(["dev", "uat", "staging", "production"])(
    "refuses when the deploy lane is %s",
    async (lane) => {
      expect(
        await gate({ NEXT_PUBLIC_APP_ENV: "development", HUSHH_DEPLOY_ENV: lane }),
      ).toBe(false);
    },
  );
});

describe("the label is still required", () => {
  it("refuses on uat and production builds regardless of lane", async () => {
    expect(await gate({ NEXT_PUBLIC_APP_ENV: "uat", HUSHH_DEPLOY_ENV: undefined })).toBe(
      false,
    );
    expect(
      await gate({ NEXT_PUBLIC_APP_ENV: "production", HUSHH_DEPLOY_ENV: undefined }),
    ).toBe(false);
  });
});

describe("dev normalises to development, which is why this matters", () => {
  it("resolveAppEnvironment maps dev to development", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_ENV = "dev";
    const { resolveAppEnvironment } = await import("@/lib/app-env");
    expect(resolveAppEnvironment()).toBe("development");
  });
});
