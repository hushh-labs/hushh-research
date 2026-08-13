import { describe, expect, it } from "vitest";

import {
  buildCircleJoinUrl,
  CIRCLE_JOIN_CODE_PARAM,
  formatCircleCodeForDisplay,
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

describe("formatCircleCodeForDisplay", () => {
  it("groups a code the way the sender sees it on their own screen", () => {
    expect(formatCircleCodeForDisplay("96REHUNFKMVX")).toBe("96RE-HUNF-KMVX");
  });

  it("normalises whatever survived the trip through a message", () => {
    // Links get lowercased, wrapped, and re-spaced by messaging apps; the code
    // on the landing page must still match the one being read aloud.
    expect(formatCircleCodeForDisplay(" 96re hunf-kmvx ")).toBe(
      "96RE-HUNF-KMVX",
    );
  });

  it("does not leave a trailing separator on an exact multiple of four", () => {
    expect(formatCircleCodeForDisplay("ABCD")).toBe("ABCD");
    expect(formatCircleCodeForDisplay("")).toBe("");
  });
});
