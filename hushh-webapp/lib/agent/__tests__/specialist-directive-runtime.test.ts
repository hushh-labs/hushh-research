import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    captureCurrentPosition: vi.fn(async () => ({ latitude: 1, longitude: 2, capturedAt: "t" })),
    storeEnvelope: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(async () => ({ ciphertext: "x", iv: "y" })),
}));

import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

describe("runLocationDirective publish_share", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures once, encrypts per recipient, stores envelopes, returns completed", async () => {
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "act-1",
        type: "publish_share",
        shares: [
          { grantId: "g1", recipientKeyId: "k1", label: "Mom" },
          { grantId: "g2", recipientKeyId: "k2", label: "Dad" },
        ],
        summary: "Share with Mom, Dad",
      },
    });
    expect(OneLocationService.captureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(encryptLocationForRecipient).toHaveBeenCalledTimes(2);
    expect(OneLocationService.storeEnvelope).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      id: "act-1",
      type: "publish_share",
      status: "completed",
    });
    // Coordinate-free result
    expect(JSON.stringify(result)).not.toContain("latitude");
  });
});
