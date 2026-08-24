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
};

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

describe("describeContactSyncOutcome — a Google read is a whole read", () => {
  // Google Contacts is read in the browser through the People API, so it
  // returns the entire address book rather than a hand-picked subset. The
  // partial-read copy and its remedies must not apply to it.
  const googleBase = {
    ...base,
    sourcePlatform: "google" as const,
    limited: false,
  };

  it("never offers the remedy that widens a partial read", () => {
    // "Check more" re-runs the picker. After a Google sync that action would
    // return the identical set and teach the person the button does nothing.
    // The web + limited combination is what routes to `pick_more`, and a
    // Google read is neither.
    const outcome = describeContactSyncOutcome({
      ...googleBase,
      matchedUserIds: ["a"],
      totalContacts: 200,
    });

    expect(outcome.remedy).not.toBe("pick_more");
    expect(outcome.remedy).not.toBe("open_settings");
  });

  it("does not scope the count to what was shared", () => {
    // "3 of the 40 contacts you shared" is true of a picker and false of a
    // whole-address-book read.
    const outcome = describeContactSyncOutcome({
      ...googleBase,
      matchedUserIds: ["a", "b", "c"],
      totalContacts: 200,
    });

    expect(outcome.title).toBe("3 people added as a contact signal.");
    expect(outcome.title).not.toContain("you shared");
  });

  it("reports an empty Google read without implying a narrowed one", () => {
    const outcome = describeContactSyncOutcome({
      ...googleBase,
      totalContacts: 40,
    });

    expect(outcome.title).toBe("No One users matched from this contact scan.");
    expect(outcome.title).not.toContain("you shared");
  });
});
