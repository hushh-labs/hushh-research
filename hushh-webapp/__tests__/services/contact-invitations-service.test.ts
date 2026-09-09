import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContactInvitationsService,
  invitationComposeUrl,
} from "@/lib/services/contact-invitations-service";
import { personalizeInvitation } from "@/lib/contacts/personalize-invitation";
const mocks = vi.hoisted(() => ({
  native: true,
  composeSms: vi.fn(),
  getCapabilities: vi.fn(),
  share: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock("@/lib/capacitor/invitations", () => ({ HushhInvitations: mocks }));
vi.mock("@/lib/share/share-link", () => ({ shareLink: mocks.share }));
vi.mock("@/lib/utils/clipboard", () => ({ copyToClipboard: mocks.copy }));
const share = {
  title: "Join One",
  text: "Join me.",
  url: "https://one.example/r/person",
  dialogTitle: "Invite",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = true;
});
afterEach(() => vi.unstubAllGlobals());

describe("invitation handoffs", () => {
  it("preserves emoji at the greeting length boundary and handles ill-formed contact names", () => {
    const displayName = `${"a".repeat(79)}😀more`;
    const personalized = personalizeInvitation(share, displayName);
    expect(personalized.text).toBe(`Hi ${"a".repeat(79)}😀,\n\nJoin me.`);
    const destination = { kind: "email" as const, value: "person@example.com" };
    const url = new URL(invitationComposeUrl(destination, personalized));
    expect(url.searchParams.get("body")).toBe(
      `${personalized.text}\n${share.url}`,
    );
    expect(() =>
      invitationComposeUrl(
        destination,
        personalizeInvitation(share, "Name\uD800"),
      ),
    ).not.toThrow();
  });
  it("invokes browser share on the original tap and preserves cancellation", async () => {
    mocks.native = false;
    const webShare = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share: webShare });
    const sharing = ContactInvitationsService.share(share);
    expect(webShare).toHaveBeenCalledTimes(1);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(await sharing).toBe("web-share");
    const cancellation = new DOMException("cancelled", "AbortError");
    webShare.mockRejectedValue(cancellation);
    await expect(ContactInvitationsService.share(share)).rejects.toBe(
      cancellation,
    );
  });
  it("personalizes the exact native payload while preserving referral attribution and missing-name fallback", async () => {
    mocks.composeSms.mockResolvedValue({ outcome: "opened" });
    const personal = personalizeInvitation(share, "  Priya\n Singh  ");
    expect(personal).toEqual({ ...share, text: "Hi Priya Singh,\n\nJoin me." });
    await ContactInvitationsService.compose(
      { kind: "phone", value: "+14155550101" },
      personal,
    );
    expect(mocks.composeSms).toHaveBeenCalledWith({
      recipient: "+14155550101",
      body: "Hi Priya Singh,\n\nJoin me.\nhttps://one.example/r/person",
    });
    expect(personalizeInvitation(share, "Contact")).toEqual(share);
    expect(personalizeInvitation(share, " ")).toEqual(share);
    const emailUrl = new URL(
      invitationComposeUrl(
        { kind: "email", value: "priya@example.com" },
        personal,
      ),
    );
    expect(emailUrl.searchParams.get("body")).toBe(
      "Hi Priya Singh,\n\nJoin me.\nhttps://one.example/r/person",
    );
  });
  it.each(["queued_or_sent", "opened", "cancelled", "failed", "unavailable"])(
    "preserves %s without inventing delivery",
    async (outcome) => {
      mocks.composeSms.mockResolvedValue({ outcome });
      expect(
        await ContactInvitationsService.compose(
          { kind: "phone", value: "+14155550101" },
          share,
        ),
      ).toBe(outcome);
      expect(mocks.composeSms).toHaveBeenCalledWith({
        recipient: "+14155550101",
        body: "Join me.\nhttps://one.example/r/person",
      });
    },
  );
  it("supports older native builds through explicit unavailability and copy fallback", async () => {
    mocks.getCapabilities.mockRejectedValue(new Error("not implemented"));
    mocks.composeSms.mockRejectedValue(new Error("not implemented"));
    expect(await ContactInvitationsService.canComposeSms()).toBe(false);
    expect(
      await ContactInvitationsService.compose(
        { kind: "phone", value: "+14155550101" },
        share,
      ),
    ).toBe("unavailable");
    mocks.copy.mockResolvedValue(true);
    expect(await ContactInvitationsService.copy(share)).toBe("copied");
    expect(mocks.copy).toHaveBeenCalledWith(
      "Join me.\nhttps://one.example/r/person",
    );
  });
  it("builds one encoded email destination and refuses header/recipient injection", () => {
    const url = invitationComposeUrl(
      { kind: "email", value: "name+tag@example.com" },
      share,
    );
    expect(url).toBe(
      "mailto:name%2Btag%40example.com?subject=Join%20One&body=Join%20me.%0Ahttps%3A%2F%2Fone.example%2Fr%2Fperson",
    );
    for (const value of [
      "a@example.com,b@example.com",
      "a@example.com?bcc=b@example.com",
      "a@example.com\r\nBcc:b@example.com",
      "a@example.com%0Abcc=x",
    ]) {
      expect(() =>
        invitationComposeUrl({ kind: "email", value }, share),
      ).toThrow();
    }
    expect(() =>
      invitationComposeUrl(
        { kind: "phone", value: "+14155550101;+14155550102" },
        share,
      ),
    ).toThrow();
  });
});
