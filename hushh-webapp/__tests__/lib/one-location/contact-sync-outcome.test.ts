import { describe, expect, it } from "vitest";

import { describeContactSyncOutcome } from "@/lib/one-location/contact-signals";

const base = {
  matchedUserIds: [] as string[],
  totalContacts: 0,
  sourcePlatform: "android" as const,
  limited: false,
  truncated: false,
  inviteCandidateCount: 0,
  autoConnectedCount: 0,
  alreadyConnectedCount: 0,
  requestRequiredCount: 0,
  uncheckableContactCount: 0,
  unknownContactCount: 0,
  mutationOutcomeUnknown: false,
  uncheckedContactCount: 0,
  lookupLimitExceeded: false,
  lookupLimitedContactCount: 0,
  partial: false,
};

describe("describeContactSyncOutcome", () => {
  it("distinguishes automatic connections from request-required matches", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a", "b", "c"],
      autoConnectedCount: 1,
      alreadyConnectedCount: 1,
      requestRequiredCount: 1,
    });

    expect(outcome.title).toBe("2 contacts connected from your contacts");
    expect(outcome.description).toContain(
      "1 contact needs a connection request.",
    );
  });

  it("offers invites only for fully checked unmatched contacts", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      totalContacts: 30,
      inviteCandidateCount: 20,
      uncheckableContactCount: 4,
    });

    expect(outcome.title).toBe("No eligible contacts matched");
    expect(outcome.description).toContain(
      "New matches require a verified phone and contact matching enabled. Existing connections may still appear.",
    );
    expect(outcome.description).toContain(
      "20 contacts were checked and can be invited.",
    );
    expect(outcome.description).toContain(
      "4 contacts had no usable phone number.",
    );
    expect(outcome.remedy).toBe("invite");
  });

  it("reports known unchecked rows and offers an idempotent retry", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      matchedUserIds: ["a"],
      totalContacts: 2501,
      uncheckedContactCount: 501,
      partial: true,
    });

    expect(outcome.title).toBe("1 contact matched in this partial sync");
    expect(outcome.description).toBe("501 contacts were not checked yet.");
    expect(outcome.remedy).toBe("sync_again");
  });

  it("does not describe a response-lost batch as unmatched or inviteable", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      totalContacts: 2500,
      unknownContactCount: 1000,
      uncheckedContactCount: 500,
      mutationOutcomeUnknown: true,
      partial: true,
    });

    expect(outcome.title).toBe("Some contact results need confirmation");
    expect(outcome.description).toContain(
      "1000 contacts need confirmation and are not counted as unmatched or inviteable.",
    );
    expect(outcome.description).toContain("500 contacts were not checked yet.");
    expect(outcome.remedy).toBe("sync_again");
  });

  it("uses the picker remedy for a partial web read", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      sourcePlatform: "web",
      limited: true,
      partial: true,
    });

    expect(outcome.remedy).toBe("pick_more");
  });

  it("uses Settings for sticky iOS limited access", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      sourcePlatform: "ios",
      limited: true,
      partial: true,
    });

    expect(outcome.remedy).toBe("open_settings");
  });

  it("does not treat non-cap unchecked contacts as a cap-only result", () => {
    const outcome = describeContactSyncOutcome({
      ...base,
      lookupLimitExceeded: true,
      lookupLimitedContactCount: 2,
      uncheckedContactCount: 3,
      partial: true,
    });

    expect(outcome.remedy).toBe("sync_again");
  });
});
