import { describe, expect, it } from "vitest";

import {
  describeLocationAsk,
  formatLocationDurationLabel,
  formatLocationRemaining,
  formatLocationTimeLeft,
  locationApproveActionLabel,
  locationAskFacts,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";

/**
 * One extra-time ask has to read the same on five surfaces: the owner's popup,
 * their approvals card and Approve button, the requester's own row, the feed,
 * and the Consent Manager. When each one worded the amount itself, the amount
 * stopped being a fact and became five opinions -- which is how "Requesting
 * more time." ended up as the only trace, anywhere, of an ask for three hours.
 */

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function request(
  overrides: Partial<OneLocationAccessRequest> = {},
): OneLocationAccessRequest {
  return {
    id: "req_1",
    ownerUserId: "user_a",
    requesterUserId: "user_b",
    status: "pending",
    requestedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  } as OneLocationAccessRequest;
}

describe("formatLocationDurationLabel", () => {
  it("says amounts the way a person would", () => {
    expect(formatLocationDurationLabel(0.25)).toBe("15 min");
    expect(formatLocationDurationLabel(0.5)).toBe("30 min");
    expect(formatLocationDurationLabel(1)).toBe("1 hour");
    expect(formatLocationDurationLabel(3)).toBe("3 hours");
    expect(formatLocationDurationLabel(1.5)).toBe("1 hour 30 min");
    expect(formatLocationDurationLabel(24)).toBe("24 hours");
  });

  it("returns nothing rather than a broken amount", () => {
    // Callers fall back to duration-free copy on "", which is honest. Printing
    // "NaN hours" on a lock screen is not.
    expect(formatLocationDurationLabel(null)).toBe("");
    expect(formatLocationDurationLabel(undefined)).toBe("");
    expect(formatLocationDurationLabel(0)).toBe("");
    expect(formatLocationDurationLabel(-3)).toBe("");
    expect(formatLocationDurationLabel("not a number")).toBe("");
  });

  it("reads a numeric string, because payloads arrive as strings", () => {
    expect(formatLocationDurationLabel("4")).toBe("4 hours");
  });
});

describe("formatLocationRemaining", () => {
  it("never overstates what is left", () => {
    expect(formatLocationRemaining(NOW + 45 * 60_000, NOW)).toBe("45 more min");
    expect(formatLocationRemaining(NOW + 60 * 60_000, NOW)).toBe("1 more hour");
    expect(formatLocationRemaining(NOW + 90 * 60_000, NOW)).toBe("1h 30m more");
    expect(formatLocationRemaining(NOW + 4 * 3_600_000, NOW)).toBe(
      "4 more hours",
    );
  });

  it("reports nothing on access that already ended", () => {
    expect(formatLocationRemaining(NOW, NOW)).toBeNull();
    expect(formatLocationRemaining(NOW - 1_000, NOW)).toBeNull();
  });
});

describe("formatLocationTimeLeft", () => {
  it("keeps baseline share time separate from extension wording", () => {
    expect(formatLocationTimeLeft(NOW + 45 * 60_000, NOW)).toBe("45 min");
    expect(formatLocationTimeLeft(NOW + 60 * 60_000, NOW)).toBe("1 hour");
    expect(formatLocationTimeLeft(NOW + 90 * 60_000, NOW)).toBe("1h 30m");
  });
});

describe("locationAskFacts", () => {
  it("treats a request against a live grant as an extension", () => {
    const facts = locationAskFacts(
      request({
        requestedDurationHours: 3,
        requestedDurationMode: "timed",
        extendsGrantId: "grant_1",
        extendsGrantExpiresAt: new Date(NOW + 45 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(facts).toEqual({
      isExtension: true,
      amountLabel: "3 hours",
      remainingLabel: "45 min",
    });
  });

  it("drops the remaining label once the extended share has run out", () => {
    const facts = locationAskFacts(
      request({
        requestedDurationHours: 3,
        extendsGrantId: "grant_1",
        extendsGrantExpiresAt: new Date(NOW - 60_000).toISOString(),
      }),
      NOW,
    );
    expect(facts.remainingLabel).toBe("");
  });
});

describe("describeLocationAsk", () => {
  it("words extra time differently from a fresh ask", () => {
    // An owner glancing at a lock screen has to tell these two questions apart
    // without opening anything. They are not the same decision.
    const extension = describeLocationAsk(
      locationAskFacts(
        request({
          requestedDurationHours: 3,
          extendsGrantId: "grant_1",
          extendsGrantExpiresAt: new Date(NOW + 45 * 60_000).toISOString(),
        }),
        NOW,
      ),
    );
    expect(extension).toBe(
      "is asking for 3 hours more of your live location. They have 45 min left.",
    );

    const fresh = describeLocationAsk(
      locationAskFacts(request({ requestedDurationHours: 3 }), NOW),
    );
    expect(fresh).toBe("is asking to view your location for 3 hours.");
  });

  it("degrades to a duration-free sentence when no amount was named", () => {
    expect(describeLocationAsk(locationAskFacts(request(), NOW))).toBe(
      "is asking to view your location.",
    );
  });

  it("says an until-stopped ask has no end", () => {
    expect(
      describeLocationAsk(
        locationAskFacts(
          request({ requestedDurationMode: "until_stopped" }),
          NOW,
        ),
      ),
    ).toBe("is asking to view your location for as long as they need.");
  });
});

describe("locationAskPromptLine", () => {
  it("leads with the amount and the baseline it is added to", () => {
    expect(
      locationAskPromptLine(
        request({
          requestedDurationHours: 4,
          extendsGrantId: "grant_1",
          extendsGrantExpiresAt: new Date(NOW + 45 * 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toBe("Asks for 4 hours more · 45 min left");
  });

  it("names the amount on a fresh ask too", () => {
    expect(
      locationAskPromptLine(request({ requestedDurationHours: 0.5 }), NOW),
    ).toBe("Asks to see your location for 30 min");
  });

  it("keeps the old wording when the ask carried no amount", () => {
    // Older clients and referral-created requests still land here.
    expect(locationAskPromptLine(request(), NOW)).toBe(
      "Asks to see your location",
    );
  });
});

describe("locationApproveActionLabel", () => {
  it("puts the number on the button, so pressing it is agreeing to one", () => {
    expect(
      locationApproveActionLabel(
        request({ requestedDurationHours: 4, extendsGrantId: "grant_1" }),
        NOW,
      ),
    ).toBe("Approve 4 hours more");
    expect(
      locationApproveActionLabel(request({ requestedDurationHours: 4 }), NOW),
    ).toBe("Approve 4 hours");
    expect(
      locationApproveActionLabel(
        request({ requestedDurationMode: "until_stopped" }),
        NOW,
      ),
    ).toBe("Approve until you stop");
  });

  it("stays a plain Approve when there is no amount to name", () => {
    expect(locationApproveActionLabel(request(), NOW)).toBe("Approve");
  });
});
