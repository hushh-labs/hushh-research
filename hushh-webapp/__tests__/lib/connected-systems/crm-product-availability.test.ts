import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isLocalCrmProductAvailable } from "@/lib/connected-systems/crm-product-availability";

describe("local CRM product availability", () => {
  it("fails closed before request-header access during Capacitor export", () => {
    const source = readFileSync(
      path.resolve(
        __dirname,
        "../../../lib/connected-systems/local-crm-route-guard.ts",
      ),
      "utf8",
    );
    const nativeGuard = source.indexOf(
      'process.env.CAPACITOR_BUILD === "true"',
    );
    const requestHeaders = source.indexOf("await headers()");

    expect(nativeGuard).toBeGreaterThanOrEqual(0);
    expect(requestHeaders).toBeGreaterThan(nativeGuard);
  });

  it("keeps request-only profile query parsing out of Capacitor export", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../app/one/profile/page.tsx"),
      "utf8",
    );
    const nativeGuard = source.indexOf(
      'process.env.CAPACITOR_BUILD !== "true"',
    );
    const requestSearchParams = source.indexOf("await searchParams");

    expect(nativeGuard).toBeGreaterThanOrEqual(0);
    expect(requestSearchParams).toBeGreaterThan(nativeGuard);
  });

  it("hides a crafted local-CRM profile route in disabled builds", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../app/profile/profile-workspace-page.tsx"),
      "utf8",
    );

    expect(source).toContain("const localCrmEnabled = isLocalCrmBuildEnabled()");
    expect(source).toContain(
      'profileRouteState.panel === "connected-systems" && !localCrmEnabled',
    );
  });

  it.each(["uat", "production"] as const)("fails closed in %s", (environment) => {
    expect(
      isLocalCrmProductAvailable({
        environment,
        hostname: "localhost",
        explicitEnabled: true,
      }),
    ).toBe(false);
  });

  it.each(["app.hushh.ai", "uat.hushh.ai", "10.0.0.8"])("rejects non-loopback host %s", (hostname) => {
    expect(
      isLocalCrmProductAvailable({
        environment: "development",
        hostname,
        explicitEnabled: true,
      }),
    ).toBe(false);
  });

  it("requires explicit enablement", () => {
    expect(
      isLocalCrmProductAvailable({
        environment: "development",
        hostname: "localhost",
        explicitEnabled: false,
      }),
    ).toBe(false);
  });

  it.each(["localhost", "127.0.0.1", "[::1]:3000"])("admits enabled loopback host %s", (hostname) => {
    expect(
      isLocalCrmProductAvailable({
        environment: "development",
        hostname,
        explicitEnabled: true,
      }),
    ).toBe(true);
  });
});
