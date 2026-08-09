import { describe, expect, it } from "vitest";

import {
  buildCircleJoinUrl,
  CIRCLE_JOIN_CODE_PARAM,
} from "@/lib/one-location/circle-join-url";

describe("buildCircleJoinUrl", () => {
  it("builds a clickable join link carrying the code query param", () => {
    expect(
      buildCircleJoinUrl("https://uat.one.hushh.ai", "96RE-HUNF-KMVX"),
    ).toBe("https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX");
  });

  it("strips a trailing slash from the origin", () => {
    expect(buildCircleJoinUrl("https://uat.one.hushh.ai/", "ABCD")).toBe(
      "https://uat.one.hushh.ai/circle/join?code=ABCD",
    );
  });

  it("URL-encodes the code", () => {
    expect(buildCircleJoinUrl("https://x.test", "A B&C")).toBe(
      "https://x.test/circle/join?code=A%20B%26C",
    );
  });

  it("omits the query when no code is given", () => {
    expect(buildCircleJoinUrl("https://x.test", "")).toBe(
      "https://x.test/circle/join",
    );
  });

  it("exposes the canonical code param name", () => {
    expect(CIRCLE_JOIN_CODE_PARAM).toBe("code");
  });
});
