import { describe, expect, it } from "vitest";

import { parseOpenMailDraftStepPayload } from "@/lib/one-voice/mail-draft-step";

const valid = () => ({
  draft: {
    to: "jhumma@example.com",
    to_name: "Jhumma",
    subject: "Demo tomorrow",
    body: "I will send you the demo tomorrow.\nThanks!",
  },
});

describe("parseOpenMailDraftStepPayload", () => {
  it("keeps the exact server-derived envelope and optional empty subject", () => {
    expect(parseOpenMailDraftStepPayload(valid())).toEqual({
      to: "jhumma@example.com",
      toName: "Jhumma",
      subject: "Demo tomorrow",
      body: "I will send you the demo tomorrow.\nThanks!",
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
});
