import { describe, expect, it } from "vitest";

import { hasActiveLocationActivity } from "@/components/dashboard/one-agent-roster";
import type { OneLocationState } from "@/lib/one-location/types";

function locationState(
  overrides: Partial<OneLocationState> = {},
): OneLocationState {
  return {
    ownerGrants: [],
    receivedGrants: [],
    recipients: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
    ...overrides,
  } as OneLocationState;
}

describe("One agent roster live indicators", () => {
  it("only treats genuine active location sharing as live", () => {
    expect(hasActiveLocationActivity(locationState())).toBe(false);
    expect(
      hasActiveLocationActivity(
        locationState({ ownerGrants: [{ status: "expired" } as any] }),
      ),
    ).toBe(false);
    expect(
      hasActiveLocationActivity(
        locationState({ ownerGrants: [{ status: "active" } as any] }),
      ),
    ).toBe(true);
    expect(
      hasActiveLocationActivity(
        locationState({ receivedGrants: [{ status: "approved" } as any] }),
      ),
    ).toBe(false);
  });
});
