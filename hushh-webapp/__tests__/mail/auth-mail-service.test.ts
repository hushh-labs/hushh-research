import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("@/lib/mail/mail-client", () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
  isMailConfigured: () => true,
}));

const MODULE_PATH = "@/lib/mail/auth-mail-service";
const APP_URL = "https://one.hushh.ai";

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
      lastSignInTime: "Wed, 05 Aug 2026 09:12:01 GMT",
    },
    ...overrides,
  };
}

// The service only reads a subset of the Admin SDK UserRecord.
async function loadService() {
  return (await import(MODULE_PATH)) as typeof import("@/lib/mail/auth-mail-service");
}

const asRecord = (user: FakeUser) =>
  user as unknown as Parameters<
    typeof import("@/lib/mail/auth-mail-service").sendSignInMail
  >[0];

describe("sign-in mail", () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ status: "sent", messageId: "<id@hushh.ai>", deduplicated: false });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("sends the welcome mail on the sign-in that created the account", async () => {
    const { sendSignInMail } = await loadService();
    const markWelcomeSent = vi.fn().mockResolvedValue(undefined);

    const outcome = await sendSignInMail(asRecord(makeUser()), {
      markWelcomeSent,
    });

    expect(outcome).toEqual({ status: "sent", kind: "welcome", messageId: "<id@hushh.ai>" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      to: "ankit@hushh.ai",
      subject: "Welcome to One",
      idempotencyKey: "one-welcome:uid-1",
    });
    expect(markWelcomeSent).toHaveBeenCalledWith("uid-1", expect.any(Number));
  });

  it("does not mark the welcome mail as sent when the send failed", async () => {
    sendMail.mockResolvedValue({ status: "failed", reason: "http_503" });
    const { sendSignInMail } = await loadService();
    const markWelcomeSent = vi.fn();

    const outcome = await sendSignInMail(asRecord(makeUser()), {
      markWelcomeSent,
    });

    expect(outcome).toEqual({ status: "failed", reason: "http_503" });
    expect(markWelcomeSent).not.toHaveBeenCalled();
  });

  it("still reports the send when the marker fails to persist", async () => {
    const { sendSignInMail } = await loadService();
    const markWelcomeSent = vi.fn().mockRejectedValue(new Error("claims unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await sendSignInMail(asRecord(makeUser()), {
      markWelcomeSent,
    });

    // The mail was delivered; calling that a failure would be the opposite of
    // what happened.
    expect(outcome).toMatchObject({ status: "sent", kind: "welcome" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never sends a second welcome, even if the account looks new again", async () => {
    const { sendSignInMail, WELCOME_MAIL_CLAIM } = await loadService();
    const user = makeUser({ customClaims: { [WELCOME_MAIL_CLAIM]: 1_754_000_000 } });

    const outcome = await sendSignInMail(asRecord(user), {
      markWelcomeSent: vi.fn(),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "welcome_already_sent" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends welcome back on a later sign-in, keyed on that sign-in", async () => {
    const { sendSignInMail } = await loadService();
    const user = makeUser({
      metadata: {
        creationTime: "Wed, 05 Aug 2026 09:12:00 GMT",
        lastSignInTime: "Fri, 07 Aug 2026 11:30:00 GMT",
      },
    });

    const outcome = await sendSignInMail(asRecord(user), {
      markWelcomeSent: vi.fn(),
    });

    expect(outcome).toMatchObject({ status: "sent", kind: "welcome_back" });
    const payload = sendMail.mock.calls[0][0];
    expect(payload.subject).toBe("Welcome back to One");
    expect(payload.idempotencyKey).toBe(
      `one-signin:uid-1:${new Date("Fri, 07 Aug 2026 11:30:00 GMT").getTime()}`,
    );
    expect(payload.html).toContain("7 August 2026 at 11:30 UTC");
  });

  it("skips an account with no email rather than failing", async () => {
    const { sendSignInMail } = await loadService();

    const outcome = await sendSignInMail(asRecord(makeUser({ email: null })), {
      markWelcomeSent: vi.fn(),
    });

    expect(outcome).toEqual({ status: "skipped", reason: "no_email" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("reports a missing binding instead of pretending it sent", async () => {
    sendMail.mockResolvedValue({ status: "not_configured" });
    const { sendSignInMail } = await loadService();

    const outcome = await sendSignInMail(asRecord(makeUser()), {
      markWelcomeSent: vi.fn(),
    });

    expect(outcome).toEqual({ status: "not_configured" });
  });
});

describe("first sign-in detection", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("treats timestamps within a minute of each other as the first sign-in", async () => {
    const { isFirstSignIn } = await loadService();
    expect(
      isFirstSignIn({
        creationTime: "Wed, 05 Aug 2026 09:12:00 GMT",
        lastSignInTime: "Wed, 05 Aug 2026 09:12:03 GMT",
      }),
    ).toBe(true);
    expect(
      isFirstSignIn({
        creationTime: "Wed, 05 Aug 2026 09:12:00 GMT",
        lastSignInTime: "Wed, 05 Aug 2026 09:20:00 GMT",
      }),
    ).toBe(false);
    expect(isFirstSignIn({})).toBe(false);
  });
});

describe("phone conflict mail", () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({ status: "sent", messageId: "<id@hushh.ai>", deduplicated: false });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("mails the signed-in person, keyed to the number so a retry does not repeat", async () => {
    const { sendPhoneConflictMail } = await loadService();

    const outcome = await sendPhoneConflictMail(asRecord(makeUser()), {
      attemptedPhoneNumber: "+919876543210",
      linkedAccountEmail: "ankit.old@gmail.com",
    });

    expect(outcome).toMatchObject({ status: "sent", kind: "phone_conflict" });
    const payload = sendMail.mock.calls[0][0];
    expect(payload.to).toBe("ankit@hushh.ai");
    expect(payload.idempotencyKey).toBe("one-phone-conflict:uid-1:919876543210");
    expect(payload.html).toContain("an•••@gmail.com");
    expect(payload.html).toContain(`href="${APP_URL}/login"`);
  });

  it("refuses an unusable phone number", async () => {
    const { sendPhoneConflictMail } = await loadService();

    const outcome = await sendPhoneConflictMail(asRecord(makeUser()), {
      attemptedPhoneNumber: "+12",
      linkedAccountEmail: null,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "invalid_phone" });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
