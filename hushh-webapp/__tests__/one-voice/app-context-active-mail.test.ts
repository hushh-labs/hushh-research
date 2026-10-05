/**
 * "Reply to this" reaches the relay as a typed position, never as prompt text.
 *
 * The open mail row is a position in a server offer plus that offer's
 * revision. The frame builder forwards both as `active_mail_ordinal` and
 * `active_mail_offer_revision`, or neither: the relay validates app_context
 * with `extra="forbid"`, so a relay that predates replies refuses the keys
 * outright, and a value outside the bounds drops the whole frame. The hint
 * never lands in `screen_state`, which is rendered into the model's prompt.
 */
import { describe, expect, it } from "vitest";

import {
  buildAppContextFrame,
  collectActiveMail,
  type ActiveMailHint,
} from "@/lib/one-voice/app-context";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const CONVERSATION_ID = "0f4d8f2e-7c3a-4b1e-9d2f-5a6b7c8d9e01";

function surface(overrides: Partial<VoiceSurfaceMetadata> = {}): VoiceSurfaceMetadata {
  return {
    screenId: "one_home",
    title: "One",
    purpose: "Home.",
    actions: [],
    availableActions: [],
    ...overrides,
  } as VoiceSurfaceMetadata;
}

function frameWith(activeMail: ActiveMailHint | null | undefined) {
  return buildAppContextFrame({ runtime: null, pathname: "/one", surface: surface(), activeMail });
}

/** Every mail key on the frame, including one set to undefined or null. */
function mailKeys(frame: object): string[] {
  return Object.keys(frame).filter((key) => /mail/i.test(key));
}

describe("active mail in app_context", () => {
  it("forwards the open row as both typed fields and nothing else from the hint", () => {
    // The provider's hint also names its conversation; that never leaves.
    const hint = { ordinal: 2, offerRevision: 7, conversationId: CONVERSATION_ID };
    const frame = frameWith(hint);
    expect(mailKeys(frame).sort()).toEqual(["active_mail_offer_revision", "active_mail_ordinal"]);
    expect(frame).toMatchObject({ active_mail_ordinal: 2, active_mail_offer_revision: 7 });
    expect(JSON.stringify(frame)).not.toContain(CONVERSATION_ID);
    // The relay's own bounds: positions 1-25 of an offer whose revision is at least 1.
    expect(collectActiveMail({ ordinal: 1, offerRevision: 1 })).toEqual({
      active_mail_ordinal: 1,
      active_mail_offer_revision: 1,
    });
    expect(collectActiveMail({ ordinal: 25, offerRevision: 1 })).toEqual({
      active_mail_ordinal: 25,
      active_mail_offer_revision: 1,
    });
  });

  it("omits both keys, never one and never null, for a hint the relay would refuse", () => {
    for (const hint of [
      { ordinal: 0, offerRevision: 7 },
      { ordinal: 26, offerRevision: 7 },
      { ordinal: 1.5, offerRevision: 7 },
      { ordinal: Number.NaN, offerRevision: 7 },
      { ordinal: 2, offerRevision: -1 },
      { ordinal: 2, offerRevision: 0 },
      { ordinal: 2, offerRevision: 2.5 },
    ]) {
      expect(mailKeys(frameWith(hint))).toEqual([]);
    }
  });

  it("never puts the position into screen_state", () => {
    const frame = buildAppContextFrame({
      runtime: null,
      pathname: "/one",
      surface: surface({ screenState: { unread_count: 4 } }),
      activeMail: { ordinal: 2, offerRevision: 7 },
    });
    expect(frame.active_mail_ordinal).toBe(2);
    expect(frame.screen_state).toEqual({ unread_count: 4 });
  });

  it("adds no mail key without a hint, so a relay that predates replies accepts the frame", () => {
    for (const activeMail of [undefined, null]) {
      const frame = frameWith(activeMail);
      expect(mailKeys(frame)).toEqual([]);
      expect(frame.type).toBe("app_context");
    }
    expect(mailKeys(buildAppContextFrame({ runtime: null, pathname: "/one", surface: null }))).toEqual([]);
  });
});
