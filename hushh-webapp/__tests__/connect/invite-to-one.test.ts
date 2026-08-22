// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INVITE_TO_ONE_DIALOG_TITLE,
  INVITE_TO_ONE_SHARE_TEXT,
  INVITE_TO_ONE_SHARE_TITLE,
  buildInviteToOneShare,
  buildInviteToOneUrl,
} from "@/lib/connect/invite-to-one";
import { resolveShareableAppOrigin } from "@/lib/share/app-origin";

vi.mock("@/lib/share/app-origin", () => ({
  resolveShareableAppOrigin: vi.fn(),
}));

const mockOrigin = vi.mocked(resolveShareableAppOrigin);

beforeEach(() => {
  mockOrigin.mockReturnValue("https://one.hushh.ai");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildInviteToOneUrl", () => {
  it("points at the anonymous onboarding entry, with nothing attached", () => {
    // Option B, deliberately: no token, no code, no pending connection. What
    // is shared is the app, and the recipient decides for themselves.
    expect(buildInviteToOneUrl()).toBe("https://one.hushh.ai/");
  });

  it("carries no query string that could be read as an authorization", () => {
    const url = new URL(buildInviteToOneUrl() as string);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/");
  });

  it("follows the origin, so a UAT invite stays on UAT", () => {
    mockOrigin.mockReturnValue("https://uat.one.hushh.ai");
    expect(buildInviteToOneUrl()).toBe("https://uat.one.hushh.ai/");
  });

  it("does not double the slash when the origin already ends in one", () => {
    // `resolveShareableAppOrigin` strips it, but a caller reading this URL in
    // a share sheet should never see `https://one.hushh.ai//`.
    mockOrigin.mockReturnValue("https://one.hushh.ai");
    const withoutScheme = buildInviteToOneUrl()?.replace(/^https?:\/\//, "");
    expect(withoutScheme).not.toContain("//");
  });

  it("is null when the build has no origin a recipient could open", () => {
    mockOrigin.mockReturnValue(null);
    expect(buildInviteToOneUrl()).toBeNull();
  });
});

describe("buildInviteToOneShare", () => {
  it("returns a payload the share ladder can send as-is", () => {
    expect(buildInviteToOneShare()).toEqual({
      title: INVITE_TO_ONE_SHARE_TITLE,
      text: INVITE_TO_ONE_SHARE_TEXT,
      dialogTitle: INVITE_TO_ONE_DIALOG_TITLE,
      url: "https://one.hushh.ai/",
    });
  });

  it("keeps the link out of the text, so targets that append url send it once", () => {
    // WhatsApp and Messages append `url` to `text`. A link written into both
    // is delivered twice, which is how the Circle invite read before it was
    // fixed.
    const share = buildInviteToOneShare();
    expect(share?.text).not.toContain("http");
    expect(share?.title).not.toContain("http");
  });

  it("does not name the sender, who is already visible in the thread", () => {
    const share = buildInviteToOneShare();
    expect(share?.text).toBe("Join me on One so we can connect.");
  });

  it("is null when there is no link, so no unusable invite is offered", () => {
    mockOrigin.mockReturnValue(null);
    expect(buildInviteToOneShare()).toBeNull();
  });
});
