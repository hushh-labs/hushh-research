import { buildPhoneMandateRoute, buildRiaClientWorkspaceRoute } from "@/lib/navigation/routes";
import { buildUrlWithQuery } from "@/lib/utils/url";

describe("url utils", () => {
  it("encodes query values and preserves existing query strings", () => {
    expect(
      buildUrlWithQuery("/consents?tab=privacy", {
        requestId: "request 1",
        from: "/kai/analysis?tab=history",
      })
    ).toBe(
      "/consents?tab=privacy&requestId=request+1&from=%2Fkai%2Fanalysis%3Ftab%3Dhistory"
    );
  });

  it("skips empty values while preserving false and zero", () => {
    expect(
      buildUrlWithQuery("/register-phone", {
        redirect: "  ",
        retry: 0,
        enabled: false,
        missing: null,
      })
    ).toBe("/register-phone?retry=0&enabled=false");
  });

  it("supports repeated query params", () => {
    expect(
      buildUrlWithQuery("/consents", {
        scope: ["profile:read", "vault write"],
      })
    ).toBe("/consents?scope=profile%3Aread&scope=vault+write");
  });

  it("backs route builders used by navigation", () => {
    expect(buildPhoneMandateRoute(" /kai/analysis?tab=history ")).toBe(
      "/register-phone?redirect=%2Fkai%2Fanalysis%3Ftab%3Dhistory"
    );
    expect(buildRiaClientWorkspaceRoute("client 1", { tab: "kai" })).toBe(
      "/ria/clients/client%201?tab=kai"
    );
  });
});
