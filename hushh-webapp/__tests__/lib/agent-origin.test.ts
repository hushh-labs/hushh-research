import { describe, expect, it } from "vitest";

import {
  agentRouteWithOrigin,
  readAgentOrigin,
} from "@/lib/navigation/agent-origin";
import { ROUTES } from "@/lib/navigation/routes";

describe("agentRouteWithOrigin", () => {
  it("records the originating page on the agent route", () => {
    expect(agentRouteWithOrigin(ROUTES.EMAIL_AGENT)).toBe(
      "/agent?from=%2Fone%2Femail",
    );
  });

  it("keeps a query string on the origin intact through a round trip", () => {
    const href = agentRouteWithOrigin("/one/gmail?tab=receipts");
    expect(readAgentOrigin(new URL(href, "https://one.hushh.ai").search)).toBe(
      "/one/gmail?tab=receipts",
    );
  });

  it("degrades to the plain route rather than encoding an unsafe origin", () => {
    for (const unsafe of ["//evil.com", "https://evil.com", "", null]) {
      expect(agentRouteWithOrigin(unsafe)).toBe(ROUTES.AGENT);
    }
  });
});

describe("readAgentOrigin", () => {
  it("reads the recorded origin", () => {
    expect(readAgentOrigin("?from=%2Fone%2Femail")).toBe("/one/email");
  });

  it("accepts a search string with or without the leading question mark", () => {
    expect(readAgentOrigin("from=/one/gmail")).toBe("/one/gmail");
  });

  it("returns null when nothing was recorded", () => {
    expect(readAgentOrigin("")).toBeNull();
    expect(readAgentOrigin(null)).toBeNull();
    expect(readAgentOrigin("?other=/one/email")).toBeNull();
  });

  it("refuses origins that would navigate off-site", () => {
    // The value arrives from the query string, so a shared link can carry
    // anything. Each of these leaves the origin if pushed unchecked.
    expect(readAgentOrigin("?from=//evil.com")).toBeNull();
    expect(readAgentOrigin("?from=https%3A%2F%2Fevil.com")).toBeNull();
    expect(readAgentOrigin("?from=%2F%5Cevil.com")).toBeNull();
    expect(readAgentOrigin("?from=javascript%3Aalert(1)")).toBeNull();
    expect(readAgentOrigin("?from=one%2Femail")).toBeNull();
  });

  it.each([
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\\evil.example",
  ])("rejects parser-normalized external origin %j", (candidate) => {
    expect(
      readAgentOrigin(`?from=${encodeURIComponent(candidate)}`),
    ).toBeNull();
    expect(agentRouteWithOrigin(candidate)).toBe(ROUTES.AGENT);
  });

  it.each(["/agent/", "/one/../agent", "/one/%2e%2e/agent"])(
    "rejects normalized self origin %s",
    (candidate) =>
      expect(
        readAgentOrigin(`?from=${encodeURIComponent(candidate)}`),
      ).toBeNull(),
  );

  it("normalizes safe internal paths while preserving query and fragment", () => {
    expect(
      readAgentOrigin(
        `?from=${encodeURIComponent("/one/../one/email?tab=drafts#latest")}`,
      ),
    ).toBe("/one/email?tab=drafts#latest");
  });

  it("refuses the agent route itself so minimize cannot loop", () => {
    expect(
      readAgentOrigin(`?from=${encodeURIComponent(ROUTES.AGENT)}`),
    ).toBeNull();
    expect(readAgentOrigin("?from=%2Fagent%3Ffrom%3D%2Fagent")).toBeNull();
  });
});
