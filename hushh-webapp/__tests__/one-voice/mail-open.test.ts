/**
 * The open-mail client: what it refuses to send, and what it refuses to believe.
 *
 * Both halves matter. An unbound request would mean "whatever list is current",
 * which is the substitution the offer binding exists to prevent. And a 200 whose
 * body does not describe a message must not render as a blank message, because
 * that tells the person their mail is empty when the read simply failed.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MailOpenError,
  mailOpenReason,
  parseOpenedMail,
} from "@/lib/one-voice/mail-open";

const CONV = "22222222-2222-4222-8222-222222222222";

describe("mail-open: what it refuses to send", () => {
  it("refuses an unbound or malformed request before it reaches the network", async () => {
    const { openOfferedMail } = await import("@/lib/one-voice/mail-open");
    const valid = {
      vaultOwnerToken: "HCT:token",
      conversationId: CONV,
      ordinal: 2,
      offerRevision: 3,
    };
    const cases: Array<[Partial<typeof valid>, string]> = [
      [{ vaultOwnerToken: "" }, "auth_missing"],
      [{ conversationId: "too-short" }, "invalid_request"],
      [{ ordinal: 0 }, "invalid_request"],
      [{ ordinal: 1.5 }, "invalid_request"],
      // A revision of zero is not a real offer: offer_mail always increments
      // before it stamps, so zero means "unbound" and must not be sent.
      [{ offerRevision: 0 }, "invalid_request"],
    ];
    for (const [patch, reason] of cases) {
      await expect(
        openOfferedMail({ ...valid, ...patch }),
      ).rejects.toMatchObject({ reason });
    }
  });
});

describe("mail-open: reasons", () => {
  it("maps the server's codes to reasons a person can act on", () => {
    expect(mailOpenReason(403, "VOICE_MAIL_READS_DISABLED")).toBe("disabled");
    expect(mailOpenReason(403, "MAIL_READS_UNAVAILABLE")).toBe("disabled");
    expect(mailOpenReason(409, "MAIL_OFFER_SUPERSEDED")).toBe(
      "offer_superseded",
    );
    expect(mailOpenReason(409, "MAIL_OFFER_UNRESOLVED")).toBe(
      "offer_unresolved",
    );
    expect(mailOpenReason(410, "SOURCE_CHANGED")).toBe("source_changed");
    expect(mailOpenReason(422, null)).toBe("invalid_request");
    expect(mailOpenReason(429, null)).toBe("rate_limited");
    // A superseded list and a position that was never offered are different
    // facts, and the person does different things about them.
    expect(mailOpenReason(409, "MAIL_OFFER_SUPERSEDED")).not.toBe(
      mailOpenReason(409, "MAIL_OFFER_UNRESOLVED"),
    );
  });

  it("keeps an unknown status unknown rather than guessing a cause", () => {
    expect(mailOpenReason(500, null)).toBe("unknown");
    expect(mailOpenReason(200, "SOMETHING_NEW")).toBe("unknown");
  });

  it("carries the live revision so a surface can say which list is current", () => {
    const error = new MailOpenError("offer_superseded", {
      status: 409,
      code: "MAIL_OFFER_SUPERSEDED",
      currentRevision: 9,
    });
    expect(error.currentRevision).toBe(9);
    expect(error.reason).toBe("offer_superseded");
  });
});

describe("mail-open: what it refuses to believe", () => {
  it("reads only the fields the message actually carried", () => {
    const parsed = parseOpenedMail({
      message: {
        source_ref: "mail:2",
        subject: "  Q3 deck  ",
        sender: "Priya Nair",
        received_at: "2026-09-28T09:00:00+00:00",
        body: "Friday please.",
        body_truncated: true,
      },
    });
    expect(parsed).toEqual({
      sourceRef: "mail:2",
      subject: "Q3 deck",
      sender: "Priya Nair",
      receivedAt: "2026-09-28T09:00:00+00:00",
      body: "Friday please.",
      bodyTruncated: true,
    });
  });

  it("leaves a missing field missing instead of inventing one", () => {
    const parsed = parseOpenedMail({
      message: { source_ref: "mail:1", sender: "Acme", subject: "   " },
    });
    // An all-whitespace subject is no subject. The view says so; it does not
    // print a blank heading as if the message had one.
    expect(parsed?.subject).toBeNull();
    expect(parsed?.body).toBeNull();
    expect(parsed?.bodyTruncated).toBe(false);
  });

  it("rejects a body that describes no message, rather than showing blank mail", () => {
    expect(parseOpenedMail(null)).toBeNull();
    expect(parseOpenedMail({})).toBeNull();
    expect(parseOpenedMail({ message: null })).toBeNull();
    // Present but empty: a 200 like this is a failure, and rendering it would
    // tell the person the message has nothing in it.
    expect(parseOpenedMail({ message: { source_ref: "mail:1" } })).toBeNull();
    expect(
      parseOpenedMail({ message: { subject: "", sender: "", body: "" } }),
    ).toBeNull();
  });

  it("does not treat a truthy non-boolean as truncation", () => {
    const parsed = parseOpenedMail({
      message: { subject: "Hi", body: "text", body_truncated: "yes" },
    });
    expect(parsed?.bodyTruncated).toBe(false);
  });
});

describe("the open_mail directive", () => {
  it("settles on the surface showing the message, not on the dispatch", async () => {
    const { executeDirective, ONE_VOICE_OPEN_MAIL_EVENT } = await import(
      "@/lib/one-voice/directives"
    );
    const seen: unknown[] = [];
    const running = executeDirective(
      "open_mail",
      { ordinal: 2, offer_revision: 7, conversation_id: CONV },
      {
        pathname: "/",
        dispatchEvent: (event) => {
          const detail = (event as CustomEvent).detail;
          seen.push({ ordinal: detail.ordinal, revision: detail.offerRevision });
          // The surface answers only once it has rendered.
          setTimeout(() => detail.settle("opened"), 0);
        },
      },
    );

    await expect(running).resolves.toMatchObject({
      handled: true,
      status: "opened",
    });
    expect(seen).toEqual([{ ordinal: 2, revision: 7 }]);
    expect(ONE_VOICE_OPEN_MAIL_EVENT).toBe("one-voice:open-mail");
  });

  it("reports failure when the surface says it could not show it", async () => {
    const { executeDirective } = await import("@/lib/one-voice/directives");
    await expect(
      executeDirective(
        "open_mail",
        { ordinal: 1, offer_revision: 7, conversation_id: CONV },
        {
          pathname: "/",
          dispatchEvent: (event) =>
            (event as CustomEvent).detail.settle("failed", "offer_mismatch"),
        },
      ),
    ).resolves.toMatchObject({ status: "failed", reason: "offer_mismatch" });
  });

  it("refuses an unbound reference instead of opening whatever is current", async () => {
    const { executeDirective } = await import("@/lib/one-voice/directives");
    const dispatched: unknown[] = [];
    const helpers = {
      pathname: "/",
      dispatchEvent: (event: Event) => dispatched.push(event),
    };
    for (const payload of [
      { ordinal: 2, offer_revision: 7 },
      { ordinal: 2, conversation_id: CONV },
      { offer_revision: 7, conversation_id: CONV },
      { ordinal: 0, offer_revision: 7, conversation_id: CONV },
      { ordinal: 26, offer_revision: 7, conversation_id: CONV },
      { ordinal: "2", offer_revision: 7, conversation_id: CONV },
    ]) {
      await expect(
        executeDirective("open_mail", payload, helpers),
      ).resolves.toMatchObject({ status: "failed", reason: "unbound_reference" });
    }
    expect(dispatched).toEqual([]);
  });

  it("times out to failed when nothing is listening", async () => {
    vi.useFakeTimers();
    try {
      const { executeDirective, OPEN_MAIL_SETTLE_TIMEOUT_MS } = await import(
        "@/lib/one-voice/directives"
      );
      const running = executeDirective(
        "open_mail",
        { ordinal: 1, offer_revision: 7, conversation_id: CONV },
        { pathname: "/", dispatchEvent: () => undefined },
      );
      await vi.advanceTimersByTimeAsync(OPEN_MAIL_SETTLE_TIMEOUT_MS + 10);
      // Nothing rendered, so One is told nothing was shown rather than assuming.
      await expect(running).resolves.toMatchObject({
        status: "failed",
        reason: "not_shown",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
