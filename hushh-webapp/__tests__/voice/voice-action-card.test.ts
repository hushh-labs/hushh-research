import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  VOICE_DISAMBIGUATION_DATA_KEY,
  clearVoiceCard,
  parseVoiceCard,
  parseVoiceConfirm,
  publishVoiceCard,
  readVoiceCard,
  subscribeToVoiceCard,
} from "@/lib/voice/voice-action-card";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    [VOICE_DISAMBIGUATION_DATA_KEY]: {
      actionId: "connect.send_request",
      resolveSlot: "userId",
      slots: { person: "Ankit Kumar Singh" },
      prompt: "2 people are called Ankit Kumar Singh.",
      candidates: [
        {
          id: "user-1",
          name: "Ankit Kumar Singh",
          detail: "a***t@hushh.ai",
          actionLabel: "Connect",
        },
        {
          id: "user-2",
          name: "Ankit Kumar Singh",
          detail: "a***3@gmail.com",
          actionLabel: "Requested",
          disabledReason: "Waiting on them",
        },
      ],
      ...overrides,
    },
  };
}

describe("parseVoiceCard", () => {
  it("reads a well-formed payload", () => {
    const parsed = parseVoiceCard(payload());
    expect(parsed).not.toBeNull();
    expect(parsed?.actionId).toBe("connect.send_request");
    expect(parsed?.resolveSlot).toBe("userId");
    expect(parsed?.slots).toEqual({ person: "Ankit Kumar Singh" });
    expect(parsed?.candidates).toHaveLength(2);
  });

  it("keeps each candidate's own button, because duplicates differ in state", () => {
    // The screenshot that prompted this feature had one row offering Connect
    // and the other showing a request already sent. A single shared label
    // would hand one of these people an action guaranteed to be refused.
    const parsed = parseVoiceCard(payload());
    expect(parsed?.candidates[0]?.actionLabel).toBe("Connect");
    expect(parsed?.candidates[0]?.disabledReason).toBeNull();
    expect(parsed?.candidates[1]?.actionLabel).toBe("Requested");
    expect(parsed?.candidates[1]?.disabledReason).toBe("Waiting on them");
  });

  it("keeps the detail line, which is the only thing telling the rows apart", () => {
    const parsed = parseVoiceCard(payload());
    expect(parsed?.candidates[0]?.detail).toBe("a***t@hushh.ai");
    expect(parsed?.candidates[1]?.detail).toBe("a***3@gmail.com");
  });

  it("returns null for anything that is not a real choice", () => {
    // Fewer than two candidates means the resolver should have answered
    // instead of asking. Rendering a card here would replace a working answer
    // with a pointless tap.
    expect(parseVoiceCard(payload({ candidates: [] }))).toBeNull();
    expect(
      parseVoiceCard(
        payload({ candidates: [{ id: "user-1", name: "Solo", actionLabel: "Connect" }] }),
      ),
    ).toBeNull();
    expect(parseVoiceCard(undefined)).toBeNull();
    expect(parseVoiceCard({})).toBeNull();
  });

  it("refuses a malformed payload so the spoken refusal survives", () => {
    // An empty card is a worse dead end than the one being fixed: a list with
    // nothing in it and no sentence explaining why. Falling back to the normal
    // blocked summary at least tells the person something.
    expect(parseVoiceCard(payload({ actionId: "" }))).toBeNull();
    expect(parseVoiceCard(payload({ resolveSlot: "" }))).toBeNull();
    expect(parseVoiceCard(payload({ candidates: "not-an-array" }))).toBeNull();
    expect(
      parseVoiceCard({ [VOICE_DISAMBIGUATION_DATA_KEY]: "nonsense" }),
    ).toBeNull();
  });

  it("drops candidates with no identity, since nothing could be run for them", () => {
    const parsed = parseVoiceCard(
      payload({
        candidates: [
          { id: "user-1", name: "Ankit", actionLabel: "Connect" },
          { id: "", name: "Ankit", actionLabel: "Connect" },
          { id: "user-3", name: "Ankit", actionLabel: "Connect" },
        ],
      }),
    );
    expect(parsed?.candidates.map((c) => c.id)).toEqual(["user-1", "user-3"]);
  });

  it("fills in safe text rather than rendering a blank row", () => {
    const parsed = parseVoiceCard(
      payload({
        prompt: "",
        candidates: [
          { id: "user-1", name: "", actionLabel: "" },
          { id: "user-2", name: "", actionLabel: "" },
        ],
      }),
    );
    expect(parsed?.prompt).toBe("Which one did you mean?");
    expect(parsed?.candidates[0]?.name).toBe("Someone");
    expect(parsed?.candidates[0]?.actionLabel).toBe("Choose");
    expect(parsed?.candidates[0]?.detail).toBeNull();
  });
});

describe("the disambiguation store", () => {
  beforeEach(() => {
    clearVoiceCard();
  });

  it("publishes and clears, notifying subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceCard(listener);

    const parsed = parseVoiceCard(payload());
    publishVoiceCard(parsed);
    expect(readVoiceCard()).toBe(parsed);
    expect(listener).toHaveBeenCalledTimes(1);

    clearVoiceCard();
    expect(readVoiceCard()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    publishVoiceCard(parsed);
    expect(listener).toHaveBeenCalledTimes(2);
    clearVoiceCard();
  });

  it("does not notify when clearing an already-empty store", () => {
    // useSyncExternalStore re-renders on every emit, and the runtime clears on
    // every local handler result -- almost all of which carry no candidates.
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceCard(listener);
    clearVoiceCard();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("parseVoiceConfirm", () => {
  function confirmPayload(overrides: Record<string, unknown> = {}) {
    return {
      confirm: {
        actionId: "connect.remove_connection",
        slots: { person: "Rashid", connectionId: "c-1" },
        prompt: "Remove your connection with Rashid?",
        subject: { name: "Rashid", detail: "r***d@gmail.com" },
        consequence: "They stop being someone you can share things with.",
        confirmLabel: "Remove",
        ...overrides,
      },
    };
  }

  it("reads a well-formed destructive confirmation", () => {
    const parsed = parseVoiceConfirm(confirmPayload());
    expect(parsed?.actionId).toBe("connect.remove_connection");
    expect(parsed?.confirmLabel).toBe("Remove");
    expect(parsed?.subject?.name).toBe("Rashid");
    expect(parsed?.subject?.detail).toBe("r***d@gmail.com");
    expect(parsed?.slots).toEqual({ person: "Rashid", connectionId: "c-1" });
  });

  it("refuses to render a destructive button with no label or no question", () => {
    // There are no safe defaults here. An unlabelled destructive button is one
    // someone presses without knowing what it does, and a card with no prompt
    // asks nothing while still offering to delete something.
    expect(parseVoiceConfirm(confirmPayload({ confirmLabel: "" }))).toBeNull();
    expect(parseVoiceConfirm(confirmPayload({ prompt: "" }))).toBeNull();
    expect(parseVoiceConfirm(confirmPayload({ actionId: "" }))).toBeNull();
    expect(parseVoiceConfirm(undefined)).toBeNull();
    expect(parseVoiceConfirm({ confirm: "nonsense" })).toBeNull();
  });

  it("drops a subject with no name rather than rendering an empty row", () => {
    const parsed = parseVoiceConfirm(
      confirmPayload({ subject: { name: "", detail: "x" } }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.subject).toBeNull();
  });
});

describe("parseVoiceCard", () => {
  it("prefers the destructive question when a handler somehow sends both", () => {
    // Asking "which one" and "are you sure" at once means the destructive half
    // is the one that must not be skipped.
    const both = {
      confirm: {
        actionId: "connect.remove_connection",
        prompt: "Remove Rashid?",
        confirmLabel: "Remove",
      },
      disambiguation: {
        actionId: "connect.send_request",
        resolveSlot: "userId",
        candidates: [
          { id: "a", name: "A", actionLabel: "Connect" },
          { id: "b", name: "B", actionLabel: "Connect" },
        ],
      },
    };
    expect(parseVoiceCard(both)?.kind).toBe("confirm");
  });

  it("tags each shape so the card knows which to render", () => {
    expect(parseVoiceCard(payload())?.kind).toBe("choice");
    expect(parseVoiceCard(undefined)).toBeNull();
  });
});
