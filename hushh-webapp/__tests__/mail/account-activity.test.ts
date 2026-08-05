import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("@/lib/mail/mail-client", () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
  isMailConfigured: () => true,
}));

const MODULE_PATH = "@/lib/mail/auth-mail-service";

type FakeUser = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  customClaims?: Record<string, unknown>;
  metadata: { creationTime?: string; lastSignInTime?: string };
};

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    uid: "uid-1",
    email: "ankit@hushh.ai",
    displayName: "Ankit Kumar Singh",
    metadata: {
      creationTime: "Wed, 05 Aug 2026 09:12:00 GMT",
      lastSignInTime: "Fri, 07 Aug 2026 11:30:00 GMT",
    },
    ...overrides,
  };
}

async function loadService() {
  return (await import(MODULE_PATH)) as typeof import("@/lib/mail/auth-mail-service");
}

const asRecord = (user: FakeUser) =>
  user as unknown as Parameters<
    typeof import("@/lib/mail/auth-mail-service").sendSignedOutMail
  >[0];

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({ status: "sent", messageId: "<id@hushh.ai>", deduplicated: false });
});

afterEach(() => {
  vi.resetModules();
});

describe("sign-out mail", () => {
  it("is keyed on the session it closes, so one session yields one of each", async () => {
    const { sendSignedOutMail } = await loadService();

    const outcome = await sendSignedOutMail(asRecord(makeUser()));

    expect(outcome).toMatchObject({ status: "sent", kind: "signed_out" });
    const payload = sendMail.mock.calls[0][0];
    expect(payload.subject).toBe("You signed out of One");
    expect(payload.idempotencyKey).toBe(
      `one-signout:uid-1:${new Date("Fri, 07 Aug 2026 11:30:00 GMT").getTime()}`,
    );
    // Distinct from the sign-in key for the same session, so neither suppresses
    // the other.
    expect(payload.idempotencyKey).not.toContain("one-signin");
  });

  it("skips an account with no address", async () => {
    const { sendSignedOutMail } = await loadService();
    expect(await sendSignedOutMail(asRecord(makeUser({ email: null })))).toEqual({
      status: "skipped",
      reason: "no_email",
    });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("capability link mail", () => {
  it("seeds silently on the first report, so existing users are not spammed", async () => {
    const { sendCapabilityLinkedMail } = await loadService();
    const markCapabilitiesMailed = vi.fn().mockResolvedValue(undefined);

    const result = await sendCapabilityLinkedMail(
      asRecord(makeUser()),
      ["gmail", "finance", "location"],
      { markCapabilitiesMailed },
    );

    expect(result).toEqual({ status: "seeded", mailed: [] });
    expect(sendMail).not.toHaveBeenCalled();
    expect(markCapabilitiesMailed).toHaveBeenCalledWith("uid-1", [
      "finance",
      "gmail",
      "location",
    ]);
  });

  it("mails only what is newly connected", async () => {
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const markCapabilitiesMailed = vi.fn().mockResolvedValue(undefined);
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: ["gmail"] } });

    const result = await sendCapabilityLinkedMail(
      asRecord(user),
      ["gmail", "finance"],
      { markCapabilitiesMailed },
    );

    expect(result).toEqual({ status: "sent", mailed: ["finance"] });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      subject: "Finance is connected to One",
      idempotencyKey: "one-linked:uid-1:finance",
    });
    expect(markCapabilitiesMailed).toHaveBeenCalledWith("uid-1", ["finance", "gmail"]);
  });

  it("says nothing when the reported set is unchanged", async () => {
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: ["gmail", "finance"] } });

    const result = await sendCapabilityLinkedMail(asRecord(user), ["finance", "gmail"], {
      markCapabilitiesMailed: vi.fn(),
    });

    expect(result).toEqual({ status: "skipped", mailed: [], reason: "nothing_new" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("never mails the same capability twice, even after disconnect and reconnect", async () => {
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: ["gmail"] } });

    // Disconnected, then reconnected: the reported set is the same as before.
    const result = await sendCapabilityLinkedMail(asRecord(user), ["gmail"], {
      markCapabilitiesMailed: vi.fn(),
    });

    expect(result.mailed).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("caps a burst and leaves the remainder for the next report", async () => {
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const markCapabilitiesMailed = vi.fn().mockResolvedValue(undefined);
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: [] } });

    const result = await sendCapabilityLinkedMail(
      asRecord(user),
      ["gmail", "finance", "location", "pkm", "consent"],
      { markCapabilitiesMailed },
    );

    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(result.mailed).toHaveLength(3);
    // The two that did not go out are not marked, so they are retried.
    expect(markCapabilitiesMailed.mock.calls[0][1]).toHaveLength(3);
  });

  it("ignores an id that is not in the catalog rather than mailing its slug", async () => {
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: [] } });

    const result = await sendCapabilityLinkedMail(
      asRecord(user),
      ["definitely-not-a-capability", "<script>alert(1)</script>"],
      { markCapabilitiesMailed: vi.fn() },
    );

    expect(result).toEqual({ status: "skipped", mailed: [], reason: "nothing_new" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does not mark a capability as mailed when its send failed", async () => {
    sendMail.mockResolvedValue({ status: "failed", reason: "http_503" });
    const { sendCapabilityLinkedMail, LINKED_MAIL_CLAIM } = await loadService();
    const markCapabilitiesMailed = vi.fn();
    const user = makeUser({ customClaims: { [LINKED_MAIL_CLAIM]: [] } });

    const result = await sendCapabilityLinkedMail(asRecord(user), ["gmail"], {
      markCapabilitiesMailed,
    });

    expect(result.status).toBe("failed");
    // Marking it would mean this connection is never mailed about at all.
    expect(markCapabilitiesMailed).not.toHaveBeenCalled();
  });
});

describe("copy parity", () => {
  it("uses the same words on screen and in the mail", async () => {
    const { PHONE_CONFLICT_COPY } = await import("@/lib/mail/account-activity-copy");
    const { buildPhoneConflictMail } = await import("@/lib/mail/auth-mail-templates");

    const mail = buildPhoneConflictMail({
      displayName: "Ankit",
      attemptedPhoneNumber: "+919876543210",
      linkedAccountEmail: "old@gmail.com",
    });

    expect(mail.subject).toBe(PHONE_CONFLICT_COPY.subject);
    expect(mail.text).toContain(PHONE_CONFLICT_COPY.heading("Ankit"));
    expect(mail.text).toContain(PHONE_CONFLICT_COPY.withAccount);
    // The in-app line points at the mail rather than repeating its detail.
    expect(PHONE_CONFLICT_COPY.inApp).toContain("another Hussh account");
  });
});
