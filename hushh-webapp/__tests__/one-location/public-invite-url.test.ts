import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX,
  PUBLIC_LOCATION_VIEW_PREFIX,
  canonicalPublicInvitePath,
  publicInviteUrlLabel,
} from "@/lib/one-location/public-invite-url";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe("canonicalPublicInvitePath", () => {
  it("rewrites the pre-rename prefix", () => {
    expect(
      canonicalPublicInvitePath(`${LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX}/tok_1`),
    ).toBe(`${PUBLIC_LOCATION_VIEW_PREFIX}/tok_1`);
    expect(canonicalPublicInvitePath(LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX)).toBe(
      PUBLIC_LOCATION_VIEW_PREFIX,
    );
  });

  it("rewrites it inside an absolute URL too", () => {
    expect(
      canonicalPublicInvitePath(
        "https://uat.one.hushh.ai/one/location/request/tok_1",
      ),
    ).toBe("https://uat.one.hushh.ai/one/location/view/tok_1");
  });

  it("leaves a link that is already canonical alone", () => {
    expect(canonicalPublicInvitePath("/one/location/view/tok_1")).toBe(
      "/one/location/view/tok_1",
    );
    expect(canonicalPublicInvitePath("")).toBe("");
  });

  it("never rewrites the token itself", () => {
    // Tokens are base64url and can hold anything. A naive substring replace
    // would corrupt a token that happens to spell the old path, and the
    // resulting link would 404 with nothing to explain why.
    const token = "abc" + LEGACY_PUBLIC_LOCATION_REQUEST_PREFIX + "def";
    expect(canonicalPublicInvitePath(`/one/location/view/${token}`)).toBe(
      `/one/location/view/${token}`,
    );
  });

  it("does not touch an unrelated route that merely starts the same way", () => {
    expect(canonicalPublicInvitePath("/one/location/requests")).toBe(
      "/one/location/requests",
    );
  });
});

describe("publicInviteUrlLabel", () => {
  it("absolutises an app-relative link against the configured origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://uat.one.hushh.ai";
    expect(publicInviteUrlLabel("/one/location/view/tok_1")).toBe(
      "https://uat.one.hushh.ai/one/location/view/tok_1",
    );
  });

  it("canonicalises a pre-rename link on its way out", () => {
    // Whatever the API hands back is what gets copied and shared. A row minted
    // before the rename — or a backend that has not rolled out yet — must not
    // put the old shape back into circulation.
    process.env.NEXT_PUBLIC_APP_URL = "https://uat.one.hushh.ai";
    expect(publicInviteUrlLabel("/one/location/request/tok_1")).toBe(
      "https://uat.one.hushh.ai/one/location/view/tok_1",
    );
  });

  it("returns an empty string for nothing", () => {
    expect(publicInviteUrlLabel("")).toBe("");
  });
});
