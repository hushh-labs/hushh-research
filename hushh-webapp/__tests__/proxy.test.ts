import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

function request(path: string): NextRequest {
  return new NextRequest(`https://one.hushh.ai${path}`);
}

describe("Next proxy root-entry contract", () => {
  it("preserves only strict opaque payment returns instead of redirecting away from their callback shell", () => {
    const path = "/one/profile/account?commerceReturn=1&commerceAttemptId=opaque_attempt_12345";
    expect(proxy(request(path)).headers.get("location")).toBeNull();
    for (const invalid of ["/one/profile/account", path + "&commerceReturn=1", path + "&private=anything", path.replace("opaque_attempt_12345", "short")]) {
      expect(new URL(proxy(request(invalid)).headers.get("location")!).pathname).toBe("/one");
    }
  });
  it("leaves the dual-mode root entry available for client auth and onboarding", () => {
    const response = proxy(request("/?redirect=%2Fone&tab=chat"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects legacy agent links to root while preserving their query", () => {
    const response = proxy(request("/agent?redirect=%2Fone&source=legacy"));
    const location = response.headers.get("location");

    expect(response.status).toBe(307);
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.pathname).toBe("/");
    expect(target.searchParams.get("redirect")).toBe("/one");
    expect(target.searchParams.get("source")).toBe("legacy");
  });

  it("redirects the trailing-slash legacy Agent variant as well", () => {
    const response = proxy(request("/agent/?source=legacy"));
    const location = response.headers.get("location");

    expect(response.status).toBe(307);
    expect(location).not.toBeNull();
    const target = new URL(location!);
    expect(target.pathname).toBe("/");
    expect(target.searchParams.get("source")).toBe("legacy");
  });

  it("does not pretend that proxy auth is available for protected app routes", () => {
    const response = proxy(request("/one"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([
    "/one/profile/connectors",
    "/one/profile/discovery",
    "/one/profile/discovery/",
    "/one/profile/hosting",
    "/one/profile/software-updates",
    "/one/profile/security/devices/authorize",
    "/one/profile/security/devices/authorize/",
  ])("keeps the canonical %s page out of the legacy profile redirect", (route) => {
    const response = proxy(request(route));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([
    ["preferences/kai", "preferences", "kai-preferences"],
    ["preferences/voice/changelog", "preferences", "voice"],
    ["preferences/voice/examples", "preferences", "voice"],
    ["support/routing", "support", "support-routing"],
    ["support/compose?kind=bug_report", "support", "support-compose:bug_report"],
    ["security/vault", "security", "vault"],
    ["gmail/actions", "gmail", "gmail-actions"],
  ])("keeps authored nested Profile destination %s", (subpath, panel, detail) => {
    for (const prefix of ["/profile", "/one/profile"]) {
      const target = new URL(proxy(request(`${prefix}/${subpath}`)).headers.get("location")!);
      expect(target.pathname).toBe("/one");
      expect(target.searchParams.get("profile_pane")).toBe("1");
      expect(target.searchParams.get("profile_panel")).toBe(panel);
      expect(target.searchParams.get("profile_detail")).toBe(detail);
    }
  });
});
