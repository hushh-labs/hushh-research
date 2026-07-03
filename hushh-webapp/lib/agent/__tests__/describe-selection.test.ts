import { describe, expect, it } from "vitest";
import { describeSelection } from "@/lib/agent/describe-selection";
import type { ClientPrompt } from "@/lib/one-location/types";

const recipientPrompt: ClientPrompt = {
  id: "p1",
  kind: "select",
  purpose: "recipient",
  question: "Who?",
  options: [
    {
      label: "Abdul Zalil",
      ref: { recipientUserId: "5dM8", recipientKeyId: "WlUg" },
    },
    { label: "Mom", ref: { recipientUserId: "mom1", recipientKeyId: "momK" } },
  ],
};

const durationPrompt: ClientPrompt = {
  id: "p2",
  kind: "select",
  purpose: "duration",
  question: "How long?",
  options: [{ label: "8 hours", ref: { hours: 8 } }],
};

describe("describeSelection", () => {
  it("maps selected refs to option labels", () => {
    expect(
      describeSelection(recipientPrompt, {
        selected: [{ recipientUserId: "5dM8", recipientKeyId: "WlUg" }],
      }),
    ).toBe("Abdul Zalil");
  });

  it("joins multiple selections", () => {
    expect(
      describeSelection(recipientPrompt, {
        selected: [
          { recipientUserId: "5dM8", recipientKeyId: "WlUg" },
          { recipientUserId: "mom1", recipientKeyId: "momK" },
        ],
      }),
    ).toBe("Abdul Zalil, Mom");
  });

  it("maps a duration selection", () => {
    expect(
      describeSelection(durationPrompt, { selected: [{ hours: 8 }] }),
    ).toBe("8 hours");
  });

  it("describes confirm / cancel / free text", () => {
    expect(
      describeSelection(
        { ...recipientPrompt, kind: "confirm" },
        { confirmed: true },
      ),
    ).toBe("Confirmed");
    expect(
      describeSelection(
        { ...recipientPrompt, kind: "confirm" },
        { confirmed: false },
      ),
    ).toBe("Declined");
    expect(describeSelection(recipientPrompt, { status: "cancelled" })).toBe(
      "Cancelled",
    );
    expect(
      describeSelection(recipientPrompt, { freeText: "share with my sister" }),
    ).toBe("share with my sister");
  });

  it("never leaks raw ids when a ref has no matching option", () => {
    const out = describeSelection(recipientPrompt, {
      selected: [{ recipientUserId: "ghost", recipientKeyId: "x" }],
    });
    expect(out).not.toContain("recipientUserId");
    expect(out).not.toContain("recipientKeyId");
  });

  it("never leaks coordinate values when a ref has no matching option", () => {
    // A location ref with a label should surface only the label, not the coords.
    const promptWithLocationRef: ClientPrompt = {
      id: "p3",
      kind: "select",
      purpose: "location",
      question: "Where?",
      options: [], // no matching option — fallback path
    };
    const out = describeSelection(promptWithLocationRef, {
      selected: [{ latitude: 37.7749, longitude: -122.4194, label: "Home" }],
    });
    expect(out).toContain("Home");
    expect(out).not.toContain("37.7749");
    expect(out).not.toContain("-122.4194");
  });
});
