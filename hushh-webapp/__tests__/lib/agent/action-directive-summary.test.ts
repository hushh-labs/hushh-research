import { describe, expect, it } from "vitest";

import {
  describeDirectiveForOwner,
  names,
  requestDurationLabel,
} from "@/lib/agent/action-directive-summary";

/**
 * Words the owner must never read on a confirmation card. They are the
 * plumbing vocabulary the model and the ledger use, and each one on a card
 * turns "do you agree to this?" into "do you understand our internals?".
 */
const BANNED_OWNER_WORDS = [
  "scope",
  "lifecycle",
  "connector",
  "domain",
  "field",
  "attribute",
  "path",
  "handle",
  "pkm",
  "manifest",
  "schema",
  "export",
  "token",
];

function expectOwnerSafe(sentence: string): void {
  const lowered = sentence.toLowerCase();
  for (const word of BANNED_OWNER_WORDS) {
    expect(lowered, `"${sentence}" leaks "${word}"`).not.toContain(word);
  }
  expect(sentence).not.toContain(String.fromCharCode(0x2014));
}

describe("names", () => {
  it("joins the way a person would say it", () => {
    expect(names(["Address"])).toBe("Address");
    expect(names(["Address", "Phone"])).toBe("Address and Phone");
    expect(names(["Address", "Phone", "Email"])).toBe("Address, Phone and Email");
  });

  it("drops blanks and keeps the sentence parsable when nothing is named", () => {
    expect(names(["", "  ", "Phone", null])).toBe("Phone");
    expect(names([])).toBe("what you asked for");
    expect(names(undefined)).toBe("what you asked for");
    expect(names("Phone")).toBe("what you asked for");
  });
});

describe("requestDurationLabel", () => {
  it("names the four standard durations", () => {
    expect(requestDurationLabel(24)).toBe("1 day");
    expect(requestDurationLabel(72)).toBe("3 days");
    expect(requestDurationLabel(168)).toBe("1 week");
    expect(requestDurationLabel(720)).toBe("30 days");
  });

  it("falls back to hours for anything else", () => {
    expect(requestDurationLabel(36)).toBe("36 hours");
  });
});

describe("describeDirectiveForOwner", () => {
  it("describes an information request with the person, the things and the duration", () => {
    const sentence = describeDirectiveForOwner(
      "consent.request",
      "Ask for information",
      {
        personRef: "person_123",
        displayName: "Sharu",
        scopeRefs: ["finance.income", "finance.assets"],
        labels: ["Income", "Assets"],
        purpose: "Planning our shared budget",
        durationHours: 168,
      },
    );
    expect(sentence).toBe("Ask Sharu for Income and Assets for 1 week.");
    expectOwnerSafe(sentence);
  });

  it("reads a string duration and defaults a missing one to a week", () => {
    expect(
      describeDirectiveForOwner("consent.request", "Ask", {
        displayName: "Sharu",
        labels: ["Income"],
        durationHours: "24",
      }),
    ).toBe("Ask Sharu for Income for 1 day.");
    expect(
      describeDirectiveForOwner("consent.request", "Ask", {
        displayName: "Sharu",
        labels: ["Income"],
      }),
    ).toBe("Ask Sharu for Income for 1 week.");
  });

  it("names nothing it does not know when the request slots did not resolve", () => {
    // A start-phase event and a frontend-staged directive carry no resolved
    // slots; asserting a recipient or a duration then would be a guess.
    const sentence = describeDirectiveForOwner("consent.request", "Ask", {});
    expect(sentence).toBe("Send the information request One set up.");
    expect(sentence).not.toContain("them");
    expect(sentence).not.toContain("week");
    expectOwnerSafe(sentence);
  });

  it("keeps a half-resolved request parsable", () => {
    expect(
      describeDirectiveForOwner("consent.request", "Ask", { displayName: "Sharu" }),
    ).toBe("Ask Sharu for what you asked for, for 1 week.");
    expect(
      describeDirectiveForOwner("consent.request", "Ask", { labels: ["Income"] }),
    ).toBe("Ask them for Income for 1 week.");
  });

  it("describes a deny", () => {
    const sentence = describeDirectiveForOwner("consent.deny", "Decline", {
      requestId: "req_abc",
    });
    expect(sentence).toBe("Decline this request.");
    expectOwnerSafe(sentence);
  });

  it("describes a revoke by holder and label, never by identifier", () => {
    const sentence = describeDirectiveForOwner("consent.revoke", "Stop sharing", {
      scope: "finance.income",
      requestId: "req_abc",
      label: "Income",
      holderLabel: "Sharu",
    });
    expect(sentence).toBe("End Sharu's access to Income.");
    expect(sentence).not.toContain("finance.income");
    expect(sentence).not.toContain("req_abc");
    expectOwnerSafe(sentence);
  });

  it("keeps a revoke honest when the holder is unknown", () => {
    const sentence = describeDirectiveForOwner("consent.revoke", "Stop sharing", {
      label: "Income",
    });
    expect(sentence).toBe("End access to Income.");
    expectOwnerSafe(sentence);
  });

  it("describes withdrawing a sent request", () => {
    const sentence = describeDirectiveForOwner(
      "consent.cancel_request",
      "Withdraw",
      { bundleId: "bundle_1", displayName: "Sharu" },
    );
    expect(sentence).toBe("Withdraw your request to Sharu.");
    expect(sentence).not.toContain("bundle_1");
    expectOwnerSafe(sentence);
    expect(
      describeDirectiveForOwner("consent.cancel_request", "Withdraw", {}),
    ).toBe("Withdraw your request.");
  });

  it("promises a pause only for a directive that owes a confirmation", () => {
    const sentence = describeDirectiveForOwner(
      "calendar.create_event",
      "Add a calendar event",
      { title: "Study" },
      { requiresConfirmation: true },
    );
    expect(sentence).toBe(
      "One is ready to add a calendar event. Nothing runs until you confirm.",
    );
    expectOwnerSafe(sentence);
  });

  it("makes no promise for a directive that runs directly", () => {
    // Most gateway actions run at once and this sentence shows while they do,
    // so "nothing runs until you confirm" would be false the moment it appeared.
    expect(
      describeDirectiveForOwner("route.connect", "Open Connect", {}, {
        requiresConfirmation: false,
      }),
    ).toBe("One is ready to open Connect.");
    expect(describeDirectiveForOwner("route.connect", "Open Connect", {})).toBe(
      "One is ready to open Connect.",
    );
  });

  it("keeps an acronym label intact and survives an empty label", () => {
    expect(
      describeDirectiveForOwner("x.y", "PDF summary", {}, { requiresConfirmation: true }),
    ).toBe("One is ready to PDF summary. Nothing runs until you confirm.");
    expect(
      describeDirectiveForOwner(null, "   ", null, { requiresConfirmation: true }),
    ).toBe("One is ready to continue. Nothing runs until you confirm.");
  });

  it("never leaks plumbing vocabulary from any branch", () => {
    const sentences = [
      describeDirectiveForOwner("consent.request", "Ask", {
        displayName: "Sharu",
        labels: ["Income", "Assets", "Address"],
        durationHours: 720,
      }),
      describeDirectiveForOwner("consent.deny", "Decline", {}),
      describeDirectiveForOwner("consent.revoke", "Stop", {}),
      describeDirectiveForOwner("consent.cancel_request", "Withdraw", {}),
      describeDirectiveForOwner("consent.request", "Ask", {}),
      describeDirectiveForOwner("other.action", "Send a note", {}),
      describeDirectiveForOwner("other.action", "Send a note", {}, {
        requiresConfirmation: true,
      }),
    ];
    for (const sentence of sentences) expectOwnerSafe(sentence);
  });
});
