import { describe, expect, it } from "vitest";

import { isLocalCrmProductAvailable } from "@/lib/connected-systems/crm-product-availability";

describe("local CRM product availability", () => {
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
