import { describe, expect, it } from "vitest";

import {
  parseMailDeliveryRef,
  parseOpenMailDraftStepPayload,
} from "@/lib/one-voice/mail-draft-step";

const valid = () => ({
  draft: {
    to: "jhumma@example.com",
    to_name: "Jhumma",
    subject: "Demo tomorrow",
    body: "I will send you the demo tomorrow.\nThanks!",
  },
});

/** Base64url body, the alphabet the server's sealed reference uses. */
const SEALED = "nX4-qL9_c2VhbGVkLXJlcGx5LXNvdXJjZQ";
const SOURCE_MAIL_REF = `rs1.${SEALED}`;
/** Shaped like the relay's `secrets.token_urlsafe(18)`. */
const DELIVERY_REF = "Zx9_aB-3cD4eF5gH6iJ7kL8m";

/** The reply step exactly as the relay sends it: the binding inside `draft`. */
const reply = () => ({
  draft: {
    to: "maya@example.com",
    to_name: "Maya Chen",
    subject: "Re: Lunch on Friday",
    body: "Friday works.\nSee you at noon.",
    mode: "reply",
    source_mail_ref: SOURCE_MAIL_REF,
  },
  delivery_ref: DELIVERY_REF,
});

describe("parseOpenMailDraftStepPayload", () => {
  it("keeps the exact server-derived envelope and optional empty subject", () => {
    expect(parseOpenMailDraftStepPayload(valid())).toEqual({
      to: "jhumma@example.com",
      toName: "Jhumma",
      subject: "Demo tomorrow",
      body: "I will send you the demo tomorrow.\nThanks!",
      mode: "compose",
      sourceMailRef: null,
    });
    const payload = valid();
    payload.draft.subject = "";
    payload.draft.body = "  Exact dictation.\n";
    expect(parseOpenMailDraftStepPayload(payload)?.body).toBe("  Exact dictation.\n");
    expect(parseOpenMailDraftStepPayload(payload)?.subject).toBe("");
  });

  it("rejects absent, malformed, or extra draft fields", () => {
    expect(parseOpenMailDraftStepPayload(null)).toBeNull();
    expect(parseOpenMailDraftStepPayload({})).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: [] })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, body: 42 } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, to_name: "" } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, cc: "other@example.com" } })).toBeNull();
  });

  it("requires exactly one valid To address", () => {
    for (const to of ["", "person", "a@example.com,b@example.com", "Name <a@example.com>", "a@example.com\nbcc:other@example.com", " a@example.com "]) {
      expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, to } })).toBeNull();
    }
  });

  it("rejects oversized fields without truncating and permits exact limits", () => {
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, subject: "s".repeat(256), body: "b".repeat(4000) } })).not.toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, subject: "s".repeat(257) } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, body: "b".repeat(4001) } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, body: "   " } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...valid().draft, subject: "a\nbcc:other@example.com" } })).toBeNull();
  });

  it("opens a reply carrying the sealed source ref from inside the draft, unaltered", () => {
    expect(parseOpenMailDraftStepPayload(reply())).toEqual({
      to: "maya@example.com",
      toName: "Maya Chen",
      subject: "Re: Lunch on Friday",
      body: "Friday works.\nSee you at noon.",
      mode: "reply",
      sourceMailRef: SOURCE_MAIL_REF,
    });
    // The server's own length bounds (SOURCE_REF_PATTERN) are both accepted.
    for (const ref of [`rs1.${"a".repeat(16)}`, `rs1.${"a".repeat(2044)}`]) {
      expect(
        parseOpenMailDraftStepPayload({ draft: { ...reply().draft, source_mail_ref: ref } })?.sourceMailRef,
      ).toBe(ref);
    }
  });

  it("refuses a reply whose source ref is missing or not the server's sealed shape", () => {
    const { source_mail_ref: _ref, ...unbound } = reply().draft;
    expect(parseOpenMailDraftStepPayload({ draft: unbound })).toBeNull();
    for (const ref of [
      null,
      42,
      "",
      `rs2.${SEALED}`,
      `rs1.${SEALED}=`,
      `rs1.${SEALED}+/`,
      `rs1.${SEALED}\n`,
      ` ${SOURCE_MAIL_REF}`,
      `rs1.${"a".repeat(15)}`,
      `rs1.${"a".repeat(2045)}`,
    ]) {
      expect(parseOpenMailDraftStepPayload({ draft: { ...reply().draft, source_mail_ref: ref } })).toBeNull();
    }
  });

  it("fails the step rather than opening a compose card that would drop a reply binding", () => {
    // A ref without reply mode must not degrade into a new, unthreaded email.
    expect(
      parseOpenMailDraftStepPayload({ draft: { ...valid().draft, source_mail_ref: SOURCE_MAIL_REF } }),
    ).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...reply().draft, mode: "forward" } })).toBeNull();
    // A reply's envelope is closed too: no thread id or extra recipient rides along.
    expect(parseOpenMailDraftStepPayload({ draft: { ...reply().draft, thread_id: "thread-1" } })).toBeNull();
    expect(parseOpenMailDraftStepPayload({ draft: { ...reply().draft, cc: "other@example.com" } })).toBeNull();
  });

  it("never turns a compose step into a reply from a ref outside the draft", () => {
    expect(
      parseOpenMailDraftStepPayload({ ...valid(), mode: "reply", source_mail_ref: SOURCE_MAIL_REF }),
    ).toEqual({
      to: "jhumma@example.com",
      toName: "Jhumma",
      subject: "Demo tomorrow",
      body: "I will send you the demo tomorrow.\nThanks!",
      mode: "compose",
      sourceMailRef: null,
    });
  });
});

describe("parseMailDeliveryRef", () => {
  it("reads the session-issued delivery ref from the step payload", () => {
    expect(parseMailDeliveryRef(reply())).toBe(DELIVERY_REF);
    // The relay's MailDeliveryResultFrame bounds: 16..64 base64url characters.
    for (const ref of ["a".repeat(16), "a".repeat(64)]) {
      expect(parseMailDeliveryRef({ delivery_ref: ref })).toBe(ref);
    }
  });

  it("returns null for a ref the relay would refuse, so no report is ever malformed", () => {
    for (const ref of ["a".repeat(15), "a".repeat(65), `${DELIVERY_REF}.x`, "Zx9/aB+3cD4eF5gH6iJ7kL8m", `${DELIVERY_REF} `, 1234567890123456]) {
      expect(parseMailDeliveryRef({ delivery_ref: ref })).toBeNull();
    }
    expect(parseMailDeliveryRef(valid())).toBeNull();
    for (const payload of [null, undefined, DELIVERY_REF, [DELIVERY_REF]]) {
      expect(parseMailDeliveryRef(payload)).toBeNull();
    }
  });
});
