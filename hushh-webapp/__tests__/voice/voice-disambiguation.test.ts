import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  VOICE_DISAMBIGUATION_DATA_KEY,
  clearVoiceDisambiguation,
  parseVoiceDisambiguation,
  publishVoiceDisambiguation,
  readVoiceDisambiguation,
  subscribeToVoiceDisambiguation,
} from "@/lib/voice/voice-disambiguation";

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

describe("parseVoiceDisambiguation", () => {
  it("reads a well-formed payload", () => {
    const parsed = parseVoiceDisambiguation(payload());
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
    const parsed = parseVoiceDisambiguation(payload());
    expect(parsed?.candidates[0]?.actionLabel).toBe("Connect");
    expect(parsed?.candidates[0]?.disabledReason).toBeNull();
    expect(parsed?.candidates[1]?.actionLabel).toBe("Requested");
    expect(parsed?.candidates[1]?.disabledReason).toBe("Waiting on them");
  });

  it("keeps the detail line, which is the only thing telling the rows apart", () => {
    const parsed = parseVoiceDisambiguation(payload());
    expect(parsed?.candidates[0]?.detail).toBe("a***t@hushh.ai");
    expect(parsed?.candidates[1]?.detail).toBe("a***3@gmail.com");
  });

  it("returns null for anything that is not a real choice", () => {
    // Fewer than two candidates means the resolver should have answered
    // instead of asking. Rendering a card here would replace a working answer
    // with a pointless tap.
    expect(parseVoiceDisambiguation(payload({ candidates: [] }))).toBeNull();
    expect(
      parseVoiceDisambiguation(
        payload({ candidates: [{ id: "user-1", name: "Solo", actionLabel: "Connect" }] }),
      ),
    ).toBeNull();
    expect(parseVoiceDisambiguation(undefined)).toBeNull();
    expect(parseVoiceDisambiguation({})).toBeNull();
  });

  it("refuses a malformed payload so the spoken refusal survives", () => {
    // An empty card is a worse dead end than the one being fixed: a list with
    // nothing in it and no sentence explaining why. Falling back to the normal
    // blocked summary at least tells the person something.
    expect(parseVoiceDisambiguation(payload({ actionId: "" }))).toBeNull();
    expect(parseVoiceDisambiguation(payload({ resolveSlot: "" }))).toBeNull();
    expect(parseVoiceDisambiguation(payload({ candidates: "not-an-array" }))).toBeNull();
    expect(
      parseVoiceDisambiguation({ [VOICE_DISAMBIGUATION_DATA_KEY]: "nonsense" }),
    ).toBeNull();
  });

  it("drops candidates with no identity, since nothing could be run for them", () => {
    const parsed = parseVoiceDisambiguation(
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
    const parsed = parseVoiceDisambiguation(
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
    clearVoiceDisambiguation();
  });

  it("publishes and clears, notifying subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceDisambiguation(listener);

    const parsed = parseVoiceDisambiguation(payload());
    publishVoiceDisambiguation(parsed);
    expect(readVoiceDisambiguation()).toBe(parsed);
    expect(listener).toHaveBeenCalledTimes(1);

    clearVoiceDisambiguation();
    expect(readVoiceDisambiguation()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    publishVoiceDisambiguation(parsed);
    expect(listener).toHaveBeenCalledTimes(2);
    clearVoiceDisambiguation();
  });

  it("does not notify when clearing an already-empty store", () => {
    // useSyncExternalStore re-renders on every emit, and the runtime clears on
    // every local handler result -- almost all of which carry no candidates.
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceDisambiguation(listener);
    clearVoiceDisambiguation();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
