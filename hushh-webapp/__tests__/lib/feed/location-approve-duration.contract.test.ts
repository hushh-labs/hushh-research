import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * No approve surface may invent a duration.
 *
 * A location access request now carries the amount the requester asked for, and
 * `approve_request` grants exactly that when the client sends no duration of its
 * own. Two surfaces did send one anyway, and both silently overrode the ask:
 *
 *   - the Feed's inline Approve hard-coded `durationHours: 1`
 *   - the Access Manager read `metadata.expiry_hours`, a key One Location's
 *     contributor never writes, and fell through to a 1-hour default
 *
 * Either one turns "give me four more hours" into a one-hour grant, and the
 * symptom is indistinguishable from a stale screen: the recipient's row reads
 * "Sharing with you, 1 more hour" because that is genuinely all they were given.
 * Nothing in a unit test of the pure helpers catches it, so the wiring is
 * asserted here against the source.
 */

const WEBAPP = join(__dirname, "..", "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(WEBAPP, relativePath), "utf8");
}

describe("the Feed's inline Approve", () => {
  const feed = source("lib/feed/use-feed-actionables.ts");

  it("does not name a duration, so the server grants what was asked", () => {
    // Isolate the OneLocationService.approveRequest call and prove no duration
    // rides along with it.
    const call = feed.match(
      /OneLocationService\.approveRequest\(\{[\s\S]*?\}\)/,
    );
    expect(call, "approveRequest call not found").toBeTruthy();
    expect(call![0]).not.toMatch(/durationHours/);
    expect(call![0]).not.toMatch(/durationMode/);
  });

  it("still identifies the request it is approving", () => {
    const call = feed.match(
      /OneLocationService\.approveRequest\(\{[\s\S]*?\}\)/,
    );
    expect(call![0]).toMatch(/requestId: request\.id/);
  });

  it("labels the button and the card from the ask, not a fixed string", () => {
    // A card that says only "Wants to see your location." gives the owner no
    // way to notice the amount, which is what let the mismatch go unseen.
    expect(feed).toMatch(/locationApproveActionLabel\(request/);
    expect(feed).toMatch(/locationAskPromptLine\(request/);
  });
});

describe("the Access Manager's duration picker", () => {
  const consentCenter = source("components/consent/consent-center-page.tsx");

  it("reads the key One Location actually writes", () => {
    // one_location_center_contributor._request_entry emits
    // `requested_duration_hours`; `expiry_hours` is the other domains' key.
    expect(consentCenter).toMatch(/metadata\?\.requested_duration_hours/);
  });

  it("still honours expiry_hours for the domains that use it", () => {
    expect(consentCenter).toMatch(/metadata\?\.expiry_hours/);
  });
});
