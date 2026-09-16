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
});
