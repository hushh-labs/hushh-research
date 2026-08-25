import { describe, expect, it } from "vitest";

import { locationWorkflowNotificationCopy } from "@/lib/one-location/notifications";

/**
 * What the other side is told when an SMS location share is stopped.
 *
 * Stopping an SMS alert revokes its grant through the same path an ordinary
 * share takes, and the copy on that path never named which of the two ended.
 * So someone who had only ever received an emergency SMS was told "X removed
 * your location access" -- about access they did not know by that name, using
 * a sentence identical to the one an ordinary share produces.
 *
 * It is not a cosmetic difference. Since #5552 a person can hold BOTH lanes
 * with the same counterpart at once, so an unnamed "your share ended" is
 * ambiguous precisely when someone is checking whether the emergency one is
 * still running.
 */
describe("stopping an SMS location share", () => {
  it("names SMS, so the recipient knows which share ended", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_share_revoked",
      ownerLabel: "Neelesh",
      shareKind: "sos",
    });

    expect(copy.title).toBe("SMS location sharing stopped");
    expect(copy.description).toBe(
      "Neelesh stopped sharing their location with you over SMS.",
    );
    // "SOS" is the server's word for the lane. The recipient's word is SMS --
    // an SMS alert is how it reached them, and the copy has to match what they
    // remember receiving rather than the column that stores it.
    expect(copy.title).not.toMatch(/SOS/i);
    expect(copy.description).not.toMatch(/SOS/i);
  });

  it("leaves an ordinary share's wording exactly as it was", () => {
    const copy = locationWorkflowNotificationCopy({
      type: "location_share_revoked",
      ownerLabel: "Neelesh",
    });

    expect(copy.description).toBe("Neelesh removed your location access.");
    expect(copy.description).not.toMatch(/SMS/i);
  });

  it("treats any non-emergency kind as an ordinary share", () => {
    // Only the emergency lane is renamed. A check-in share is still a share.
    for (const shareKind of ["standard", "check_in", "", null, undefined]) {
      const copy = locationWorkflowNotificationCopy({
        type: "location_share_revoked",
        ownerLabel: "Neelesh",
        shareKind,
      });
      expect(copy.description).toBe("Neelesh removed your location access.");
    }
  });
});
