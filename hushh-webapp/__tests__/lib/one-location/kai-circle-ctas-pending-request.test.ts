import { describe, expect, it } from "vitest";

import { resolveKaiCircleCtas } from "@/lib/one-location/kai-circle-ctas";
import type { KaiCircleCandidate } from "@/lib/one-location/types";

function minimalCandidate(
  overrides: Partial<KaiCircleCandidate> = {},
): KaiCircleCandidate {
  return {
    candidateId: "user:user_x",
    displayName: "Test User",
    phoneVerified: true,
    keyAlgorithm: "test-key-algorithm",
    canReceiveLocation: true,
    isShareReady: true,
    readiness: "location_ready",
    sourceTypes: ["one_location_recipient"],
    isDiscoverable: true,
    ...overrides,
  };
}

describe("resolveKaiCircleCtas", () => {
  it("returns approve and deny CTAs for pending owner requests", () => {
    const ctas = resolveKaiCircleCtas({
      candidate: minimalCandidate(),
      mode: "share",
      hasPendingOwnerRequest: true,
    });

    expect(ctas).toEqual([
      {
        id: "approve",
        label: "Approve",
        enabled: true,
      },
      {
        id: "deny",
        label: "Deny",
        enabled: true,
      },
    ]);
  });
});