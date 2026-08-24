import { describe, expect, it } from "vitest";

import { describeContactSyncOutcome } from "@/lib/one-location/contact-signals";

/**
 * A partial contact read must never be reported as a whole one.
 *
 * The web Contact Picker and iOS limited access both return only a hand-picked
 * subset. Phrasing that as "3 people added as a contact signal" tells the user
 * their whole address book was searched, which is the wrong conclusion to draw
 * about who is and is not on Hushh.
 */
const base = {
  matchedUserIds: [] as string[],
  totalContacts: 0,
  sourcePlatform: "android" as const,
  limited: false,
  truncated: false,
  inviteCandidateCount: 0,
};

describe("describeContactSyncOutcome — the people who are NOT on Hushh", () => {
  // `inviteCandidateCount` has been computed on every sync since this file
  // shipped and read by nothing except an analytics dimension. The product
  // learned "forty of your contacts are not here yet", recorded it, and told
  // the person nothing.

  it("names them, and offers the invite, after a full read that matched", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a", "b"],
      totalContacts: 50,
      inviteCandidateCount: 48,
    });
    expect(outcome.title).toBe("2 people added as a contact signal.");
    expect(outcome.description).toBe("48 contacts are not on Hushh yet.");
    expect(outcome.remedy).toBe("invite");
  });

  it("offers the invite when a full read matched nobody", () => {
    // The strongest moment for the loop: every contact is a candidate.
    const outcome = describeContactSyncOutcome({
      ...base,
      totalContacts: 30,
      inviteCandidateCount: 30,
    });
    expect(outcome.title).toBe("No One users matched from this contact scan.");
    expect(outcome.description).toBe("30 contacts could be invited.");
    expect(outcome.remedy).toBe("invite");
  });

  it("says nothing about inviting when everyone is already here", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a", "b"],
      totalContacts: 2,
      inviteCandidateCount: 0,
    });
    expect(outcome.description).toBeUndefined();
    expect(outcome.remedy).toBeNull();
  });

  it("never takes the slot from a remedy that widens a partial read", () => {
    // A partial read owns the action with "Check more" / "Open Settings".
    // Widening the read is the better next step than inviting out of a list
    // the person has not finished choosing from — and the toast has one slot.
    const web = describeContactSyncOutcome({
      ...base,
      totalContacts: 10,
      sourcePlatform: "web",
      limited: true,
      inviteCandidateCount: 10,
    });
    expect(web.remedy).toBe("pick_more");

    const ios = describeContactSyncOutcome({
      ...base,
      totalContacts: 10,
      sourcePlatform: "ios",
      limited: true,
      inviteCandidateCount: 10,
    });
    expect(ios.remedy).toBe("open_settings");
  });

  it("singularises one candidate", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      totalContacts: 1,
      inviteCandidateCount: 1,
    });
    expect(outcome.description).toBe("1 contact could be invited.");
  });
});

describe("describeContactSyncOutcome", () => {
  it("reports a full read as a plain count with no remedy", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a", "b", "c"],
      totalContacts: 400,
    });
    expect(outcome.title).toBe("3 people added as a contact signal.");
    expect(outcome.remedy).toBeNull();
    expect(outcome.description).toBeUndefined();
  });

  it("says how many of the shared contacts matched when access was partial", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a", "b", "c"],
      totalContacts: 40,
      sourcePlatform: "web",
      limited: true,
    });
    // The count must be scoped to what was actually checked.
    expect(outcome.title).toBe("3 of the 40 contacts you shared are on Hushh");
    expect(outcome.description).toContain("not your whole address book");
  });

  it("offers the picker again on web, never a settings page that cannot help", () => {
    // openAppSettings resolves false in a browser, so a Settings action there
    // is a button that silently does nothing.
    const web = describeContactSyncOutcome({
      ...base,
      totalContacts: 10,
      sourcePlatform: "web",
      limited: true,
    });
    expect(web.remedy).toBe("pick_more");
  });

  it("offers settings on iOS limited access, where the subset is sticky", () => {
    const ios = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a"],
      totalContacts: 12,
      sourcePlatform: "ios",
      limited: true,
    });
    expect(ios.remedy).toBe("open_settings");
    expect(ios.description).toContain("shared with Hushh");
  });

  it("does not answer a dismissed picker with a result it never had", () => {
    // `contacts-web.ts` reads an AbortError as an empty read, so closing the
    // sheet arrives here as limited + zero. The old wording -- "None of the 0
    // contacts you shared are on Hushh yet" -- is shaped like a finding and
    // reports one nobody asked for, on the most common way out of the flow.
    const outcome = describeContactSyncOutcome({
      ...base,
      sourcePlatform: "web",
      limited: true,
      totalContacts: 0,
    });

    expect(outcome.title).not.toMatch(/0 contacts/);
    expect(outcome.title).not.toMatch(/are on Hushh yet/);
    expect(outcome.title).toBe("No contacts were shared, so nothing was checked.");
    // Still the remedy that widens the read, because that is the way forward.
    expect(outcome.remedy).toBe("pick_more");
  });

  it("says where to widen it when iOS shared nothing at all", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      sourcePlatform: "ios",
      limited: true,
      totalContacts: 0,
    });

    // Settings, not the picker: on iOS the empty subset is sticky, and
    // openAppSettings is the only thing that changes it.
    expect(outcome.remedy).toBe("open_settings");
    expect(outcome.description).toMatch(/Settings/);
  });

  it("does not claim nobody matched when only a subset was searched", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      totalContacts: 25,
      sourcePlatform: "web",
      limited: true,
    });
    expect(outcome.title).toBe(
      "None of the 25 contacts you shared are on Hushh yet",
    );
    expect(outcome.title).not.toContain("No One users matched");
  });

  it("still reports a genuine empty result plainly on a full read", () => {
    const outcome = describeContactSyncOutcome({ ...base, totalContacts: 300 });
    expect(outcome.title).toBe("No One users matched from this contact scan.");
    expect(outcome.remedy).toBeNull();
  });

  it("flags a truncated book, which is partial for a different reason", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a"],
      totalContacts: 5000,
      truncated: true,
    });
    expect(outcome.title).toBe("1 person added as a contact signal.");
    expect(outcome.description).toContain("larger than the sync limit");
  });

  it("uses singular wording for a single contact and a single match", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a"],
      totalContacts: 1,
      sourcePlatform: "web",
      limited: true,
    });
    expect(outcome.title).toBe("1 of the 1 contact you shared is on Hushh");
  });
});
