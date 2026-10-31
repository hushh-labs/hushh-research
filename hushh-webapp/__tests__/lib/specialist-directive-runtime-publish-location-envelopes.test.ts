import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPublishLocationEnvelopesDirective,
  runLocationDirective,
} from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";
import * as encryption from "@/lib/one-location/encryption";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    requestLocationPermission: vi.fn(),
    captureCurrentPosition: vi.fn(),
    getState: vi.fn(),
    storeEnvelope: vi.fn(),
    viewEnvelope: vi.fn(),
    createPublicInvite: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(),
}));

/**
 * agent-bar.tsx has no test scaffolding of its own (nothing else in this
 * component is unit-tested directly -- it needs two dozen mocked hooks to
 * even render), so the new `publish_location_envelopes` branch is tested at
 * its two real seams instead: the pure translation this file exports, and
 * runLocationDirective's own publish_share handling it feeds into. Together
 * they cover exactly what the branch does -- agent-bar.tsx itself is three
 * lines of glue between the two, checked by tsc/eslint rather than restated
 * here as a mock of a mock.
 */
describe("buildPublishLocationEnvelopesDirective", () => {
  const shares = [
    { grantId: "grant-1", recipientKeyId: "key-1", recipientUserId: "user-1", label: "Sarah" },
    { grantId: "grant-2", recipientKeyId: "key-2", recipientUserId: "user-2", label: "Alex" },
  ];

  it("translates a parked payload into a runnable action directive", () => {
    const directive = buildPublishLocationEnvelopesDirective({ shares });

    expect(directive?.kind).toBe("action");
    expect(directive?.payload.type).toBe("publish_share");
    expect(directive?.payload.shares).toEqual(shares);
    // Auto-fires -- there is no confirm step here to gate on, so the only
    // thing an id needs to do is exist and be unique per turn.
    expect(typeof directive?.payload.id).toBe("string");
    expect((directive?.payload.id as string).length).toBeGreaterThan(0);
  });

  it("returns null when the directive carries no shares", () => {
    expect(buildPublishLocationEnvelopesDirective({ shares: [] })).toBeNull();
    expect(buildPublishLocationEnvelopesDirective({})).toBeNull();
    expect(buildPublishLocationEnvelopesDirective(undefined)).toBeNull();
  });

  it("returns null rather than trust a malformed shares field", () => {
    expect(buildPublishLocationEnvelopesDirective({ shares: "grant-1" })).toBeNull();
    expect(buildPublishLocationEnvelopesDirective({ shares: null })).toBeNull();
  });
});

describe("runLocationDirective(publish_share) run directly from a built directive", () => {
  const mockCapture = vi.mocked(OneLocationService.captureCurrentPosition);
  const mockGetState = vi.mocked(OneLocationService.getState);
  const mockStore = vi.mocked(OneLocationService.storeEnvelope);
  const mockEncrypt = vi.mocked(encryption.encryptLocationForRecipient);

  beforeEach(() => {
    mockCapture.mockReset();
    mockGetState.mockReset();
    mockStore.mockReset();
    mockEncrypt.mockReset();
  });

  it("captures once, encrypts and stores per recipient, with no confirm step in between", async () => {
    const point = { lat: 1, lng: 2 };
    mockCapture.mockResolvedValue(point as never);
    mockGetState.mockResolvedValue({
      recipients: [
        { keyId: "key-1", publicKeyJwk: { kty: "EC" } },
        { keyId: "key-2", publicKeyJwk: { kty: "EC" } },
      ],
    } as never);
    mockEncrypt.mockResolvedValue({ ciphertext: "envelope" } as never);
    mockStore.mockResolvedValue(undefined as never);

    const directive = buildPublishLocationEnvelopesDirective({
      shares: [
        { grantId: "grant-1", recipientKeyId: "key-1", label: "Sarah" },
        { grantId: "grant-2", recipientKeyId: "key-2", label: "Alex" },
      ],
    });
    expect(directive).not.toBeNull();

    // Calling it directly -- exactly as agent-bar.tsx's new branch does, with
    // no card and no tap -- is itself the proof there is no confirm step: a
    // gated flow would need a separate confirmation call before this could
    // succeed, and there is none here for it to be missing.
    const result = await runLocationDirective(directive!, "vault-token", "user-1");

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockEncrypt).toHaveBeenCalledTimes(2);
    expect(mockStore).toHaveBeenCalledTimes(2);
    expect(mockStore).toHaveBeenNthCalledWith(1, {
      vaultOwnerToken: "vault-token",
      grantId: "grant-1",
      envelope: { ciphertext: "envelope" },
    });
    expect(mockStore).toHaveBeenNthCalledWith(2, {
      vaultOwnerToken: "vault-token",
      grantId: "grant-2",
      envelope: { ciphertext: "envelope" },
    });
    expect(result.status).toBe("completed");
  });

  it("never trusts a directive-supplied key -- an unmatched recipientKeyId resolves failed instead of publishing blind", async () => {
    mockCapture.mockResolvedValue({ lat: 1, lng: 2 } as never);
    // Server state has no recipient at all for this keyId -- the directive's
    // own label is irrelevant, the lookup is by keyId against server state.
    mockGetState.mockResolvedValue({ recipients: [] } as never);

    const directive = buildPublishLocationEnvelopesDirective({
      shares: [{ grantId: "grant-1", recipientKeyId: "key-missing", label: "Sarah" }],
    });

    // runLocationDirective never throws -- every internal failure is caught
    // and reported as a resolved result with status "failed" (see the
    // catch-all in specialist-directive-runtime.ts), which is what
    // agent-bar.tsx's new branch reads instead of a try/catch.
    const result = await runLocationDirective(directive!, "vault-token", "user-1");
    expect(result.status).toBe("failed");
    expect(result.detail).toMatch(/hasn't set up location sharing yet/);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });
});
