import { describe, expect, it } from "vitest";

import { classifySpokenConfirmation } from "@/lib/voice/spoken-confirmation";

/**
 * Every case here is a sentence someone can really say while a confirmation
 * card is open. A wrong `affirm` runs an action nobody approved -- for the
 * high-risk ten that means a location share or a KYC send -- so the cases
 * that must NOT read as consent matter more than the ones that must.
 */

describe("plain answers", () => {
  it("accepts the ordinary ways of saying yes", () => {
    ["yes", "yeah", "yep", "sure", "go ahead", "do it", "confirm", "okay"].forEach(
      (reply) => {
        expect(classifySpokenConfirmation(reply)).toBe("affirm");
      },
    );
  });

  it("accepts the ordinary ways of saying no", () => {
    ["no", "nope", "cancel", "stop", "never mind", "not now", "wait"].forEach(
      (reply) => {
        expect(classifySpokenConfirmation(reply)).toBe("decline");
      },
    );
  });

  it("ignores punctuation and case the speech engine may or may not emit", () => {
    // "yes." and "Yes" must not take different paths than "yes".
    ["Yes.", "YES!", "  yes  ", "Yes?"].forEach((reply) => {
      expect(classifySpokenConfirmation(reply)).toBe("affirm");
    });
  });
});

describe("what must never be read as consent", () => {
  it("does not treat a yes inside a longer sentence as an answer", () => {
    // The failure this guard exists for: someone carries on talking while a
    // card is open, and a bare keyword match hears agreement in narration.
    [
      "yes I told Sarah I would be there by six",
      "she said yes to the meeting yesterday afternoon",
      "no I was talking about the other thing entirely",
    ].forEach((reply) => {
      expect(classifySpokenConfirmation(reply)).toBe("unclear");
    });
  });

  it("refuses a qualified yes", () => {
    // "yes but not Sarah" contains an affirmative and means stop. A genuine
    // yes rarely needs a hedge, so any hedge withholds consent.
    [
      "yes but not Sarah",
      "yes wait",
      "yes actually no",
      "okay but hold on",
      "sure instead do that",
    ].forEach((reply) => {
      expect(classifySpokenConfirmation(reply)).toBe("unclear");
    });
  });

  it("lets a decline beat an affirmative in the same breath", () => {
    // A contradiction is not a yes. The safe reading is to not act.
    expect(classifySpokenConfirmation("no go ahead")).toBe("decline");
    expect(classifySpokenConfirmation("no do it")).toBe("decline");
  });

  it("treats a new request as a new request, not an answer", () => {
    [
      "share with someone else for four hours",
      "open my active shares instead",
      "what time is it",
    ].forEach((reply) => {
      expect(classifySpokenConfirmation(reply)).toBe("unclear");
    });
  });

  it("says nothing about silence", () => {
    // Not a soft no: cancelling on an empty transcript is its own wrong.
    ["", "   ", "\n"].forEach((reply) => {
      expect(classifySpokenConfirmation(reply)).toBe("unclear");
    });
  });
});

describe("short compound replies", () => {
  it("accepts a reply made entirely of affirmative parts", () => {
    expect(classifySpokenConfirmation("yes please")).toBe("affirm");
    expect(classifySpokenConfirmation("okay do it")).toBe("affirm");
    expect(classifySpokenConfirmation("sure go ahead")).toBe("affirm");
  });

  it("still refuses when one part is not affirmative", () => {
    // "yes Sarah" names a person; it is a correction or a clarification, not
    // consent to what was asked.
    expect(classifySpokenConfirmation("yes Sarah")).toBe("unclear");
    expect(classifySpokenConfirmation("yes four hours")).toBe("unclear");
  });
});
