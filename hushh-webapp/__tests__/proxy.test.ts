import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

function request(path: string): NextRequest {
  return new NextRequest(`https://one.hushh.ai${path}`);
}

describe("Next proxy root-entry contract", () => {
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

  it("sends the legacy Connectors address into the Profile pane, detail included", () => {
    const list = new URL(proxy(request("/one/profile/connectors")).headers.get("location")!);
    expect(list.pathname).toBe("/one");
    expect(list.searchParams.get("profile_pane")).toBe("1");
    expect(list.searchParams.get("profile_panel")).toBe("connectors");
    expect(list.searchParams.has("profile_detail")).toBe(false);

    const detail = new URL(
      proxy(request("/one/profile/connectors?connector=google_drive")).headers.get("location")!,
    );
    expect(detail.searchParams.get("profile_detail")).toBe("connector:google_drive");
    expect(detail.searchParams.has("connector")).toBe(false);

    // An address-bar value that is not a catalog id opens the list, never a detail.
    const forged = new URL(
      proxy(request("/one/profile/connectors?connector=%3Cscript%3E")).headers.get("location")!,
    );
    expect(forged.searchParams.has("profile_detail")).toBe(false);
  });

  it("never redirects the provider-registered connector OAuth return", () => {
    // Deploy-enforced: providers send the person to exactly this address.
    const response = proxy(
      request("/one/profile/connectors/oauth/return?code=synthetic&state=synthetic"),
    );

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
