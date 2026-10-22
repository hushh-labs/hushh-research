import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContactInvitationsService,
  invitationComposeUrl,
  invitationBatchEmailUrl,
} from "@/lib/services/contact-invitations-service";
import { personalizeInvitation } from "@/lib/contacts/personalize-invitation";
const mocks = vi.hoisted(() => ({
  native: true,
  platform: "ios",
  composeSms: vi.fn(),
  composeSmsBatch: vi.fn(),
  getCapabilities: vi.fn(),
  share: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => mocks.platform,
  },
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
  mocks.platform = "ios";
});
afterEach(() => vi.unstubAllGlobals());

describe("invitation handoffs", () => {
  it("passes the same session guard through native sharing and clipboard recovery", async () => {
    let current = true;
    const isCurrent = () => current;
    mocks.share.mockResolvedValue("native-share");
    mocks.copy.mockResolvedValue(true);
    await expect(
      ContactInvitationsService.share(share, isCurrent),
    ).resolves.toBe("native-share");
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(share, isCurrent);
    await expect(
      ContactInvitationsService.copy(share, isCurrent),
    ).resolves.toBe("copied");
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(
      "Join me.\nhttps://one.example/r/person",
      isCurrent,
    );
    current = false;
    await expect(
      ContactInvitationsService.share(share, isCurrent),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      ContactInvitationsService.copy(share, isCurrent),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.share).toHaveBeenCalledTimes(1);
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    mocks.native = false;
    const webShare = vi.fn();
    vi.stubGlobal("navigator", { share: webShare });
    await expect(
      ContactInvitationsService.share(share, isCurrent),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(webShare).not.toHaveBeenCalled();
  });

  it("only advances on supported completed handoffs; Android chooser/compose return is ambiguous", () => {
    expect(ContactInvitationsService.completesRecipient("queued_or_sent")).toBe(
      true,
    );
    expect(ContactInvitationsService.completesRecipient("native-share")).toBe(
      true,
    );
    mocks.platform = "android";
    for (const outcome of [
      "native-share",
      "opened",
      "cancelled",
      "failed",
      "unavailable",
      "copied",
      "launch_requested",
    ] as const) {
      expect(ContactInvitationsService.completesRecipient(outcome)).toBe(false);
    }
    mocks.platform = "web";
    expect(ContactInvitationsService.completesRecipient("web-share")).toBe(
      true,
    );
  });
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
      expect.any(Function),
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

describe("batch invitation boundary", () => {
  const phones = Array.from({ length: 15 }, (_, index) => ({
    kind: "phone" as const,
    value: `+1415555${String(index).padStart(4, "0")}`,
  }));
  beforeEach(() => {
    mocks.getCapabilities.mockResolvedValue({
      sms: true,
      maxSmsRecipients: 15,
    });
    mocks.composeSmsBatch.mockResolvedValue({ outcome: "opened" });
  });
  it("opens one 15-recipient native draft with the common body and no legacy calls", async () => {
    expect(await ContactInvitationsService.composeBatch(phones, share)).toBe(
      "opened",
    );
    expect(mocks.composeSmsBatch).toHaveBeenCalledExactlyOnceWith({
      recipients: phones.map((phone) => phone.value),
      body: "Join me.\nhttps://one.example/r/person",
    });
    expect(mocks.composeSms).not.toHaveBeenCalled();
  });
  it("rejects invalid, duplicate, empty, oversized and mixed-channel batches before native handoff", async () => {
    for (const recipients of [
      [],
      [...phones, { kind: "phone" as const, value: "+14155559999" }],
      [phones[0]!, phones[0]!],
      [{ kind: "phone" as const, value: "+14155550101\n" }],
      [{ kind: "phone" as const, value: "+14155550101,+14155550102" }],
      [phones[0]!, { kind: "email" as const, value: "a@example.com" }],
    ]) {
      await expect(
        ContactInvitationsService.composeBatch(recipients, share),
      ).rejects.toThrow();
    }
    expect(mocks.composeSmsBatch).not.toHaveBeenCalled();
  });
  it("never interprets legacy SMS support as batch support or silently drops recipients", async () => {
    for (const capabilities of [
      { sms: true },
      { sms: false, maxSmsRecipients: 15 },
      { sms: true, maxSmsRecipients: 1 },
    ]) {
      mocks.getCapabilities.mockResolvedValue(capabilities);
      expect(await ContactInvitationsService.canComposeBatchSms()).toBe(false);
      expect(await ContactInvitationsService.composeBatch(phones, share)).toBe(
        "unavailable",
      );
    }
    expect(mocks.composeSmsBatch).not.toHaveBeenCalled();
    expect(mocks.composeSms).not.toHaveBeenCalled();
  });
  it("does not disclose recipients after the invitation session ends during the capability probe", async () => {
    let finish!: (value: { sms: boolean; maxSmsRecipients: number }) => void;
    mocks.getCapabilities.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let current = true;
    const result = ContactInvitationsService.composeBatch(
      phones,
      share,
      () => current,
    );
    current = false;
    finish({ sms: true, maxSmsRecipients: 15 });
    expect(await result).toBe("cancelled");
    expect(mocks.composeSmsBatch).not.toHaveBeenCalled();
  });
  it("requests one web BCC draft on the tap with every email and the unchanged invitation link", async () => {
    mocks.native = false;
    const recipients = Array.from({ length: 15 }, (_, index) => ({
      kind: "email" as const,
      value: `friend+${index}@example.com`,
    }));
    const url = invitationBatchEmailUrl(recipients, share);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("");
    expect(parsed.searchParams.get("bcc")).toBe(
      recipients.map((email) => email.value).join(","),
    );
    expect(parsed.searchParams.has("to")).toBe(false);
    expect(parsed.searchParams.has("cc")).toBe(false);
    expect(parsed.searchParams.get("body")).toBe(
      "Join me.\r\nhttps://one.example/r/person",
    );
    expect(url).toContain("friend%2B0%40example.com");
    const location = { href: "" };
    vi.stubGlobal("window", { location });
    const promise = ContactInvitationsService.composeBatch(recipients, share);
    expect(location.href).toBe(url);
    expect(await promise).toBe("launch_requested");
    expect(mocks.composeSmsBatch).not.toHaveBeenCalled();
    for (const value of [
      "a@example.com?to=b@example.com",
      "a@example.com,b@example.com",
      "a@example.com\r\nCc:b@example.com",
      "a@example.com%0abcc=x",
    ]) {
      expect(() =>
        invitationBatchEmailUrl([{ kind: "email", value }], share),
      ).toThrow();
    }
    expect(() =>
      invitationBatchEmailUrl(
        [
          { kind: "email", value: "A@example.com" },
          { kind: "email", value: "a@EXAMPLE.com" },
        ],
        share,
      ),
    ).toThrow();
    expect(() =>
      invitationBatchEmailUrl(recipients, {
        ...share,
        title: "Invite\r\nBcc:other@example.com",
      }),
    ).toThrow();
    expect(() =>
      invitationBatchEmailUrl(recipients, { ...share, text: "😀".repeat(900) }),
    ).toThrow(/too long/);
  });
});
