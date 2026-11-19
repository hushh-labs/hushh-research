import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  bootstrap: vi.fn(),
  seal: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.api },
}));
vi.mock("@/lib/one-location/key-bootstrap", () => ({
  bootstrapCurrentUserLocationRecipientKey: mocks.bootstrap,
}));
vi.mock("@/lib/one-location/encryption", () => ({
  sealRecipientPayload: mocks.seal,
  openRecipientPayload: mocks.open,
  RecipientPayloadKeyUnavailableError: class extends Error {},
}));
import {
  AdvisorReviewService,
  AdvisorReviewError,
} from "@/lib/advisor-review/service";
import {
  advisorSnapshotContext,
  type AdvisorCandidate,
  type AdvisorSnapshot,
} from "@/lib/advisor-review/contract";

let current = true;
const context = {
  userId: "owner",
  vaultKey: "synthetic-key",
  vaultOwnerToken: "synthetic-owner",
  getIdToken: async () => "synthetic-identity",
  isCurrent: () => current,
};
const candidate: AdvisorCandidate = {
  userId: "advisor",
  personRef: "11111111-1111-4111-8111-111111111111",
  name: "Sample advisor",
  bio: "",
  crd: null,
  verified: true,
  keyId: "advisor-key",
  publicKeyJwk: { kty: "EC" },
  ready: true,
};
const snapshot: AdvisorSnapshot = {
  schema: "advisor-finance-snapshot-v1",
  capturedAt: "2026-11-02T12:00:00Z",
  source: "statement",
  period: null,
  total: 10000,
  cash: 1000,
  holdings: [
    {
      symbol: "TEST",
      name: "Synthetic company",
      value: 9000,
      quantity: 10,
      costBasis: 8000,
      sector: "Technology",
      assetType: "equity",
    },
  ],
  allocation: [{ name: "Equity", value: 9000 }],
  history: [],
  profile: { horizon: null, risk: null, drawdown: null, volatility: null },
  nonce: "a".repeat(64),
};
const envelope = (recipientKeyId: string) => ({
  algorithm: "ECDH-P256-AES256-GCM" as const,
  recipientKeyId,
  iv: "A".repeat(16),
  ciphertext: "A".repeat(64),
  senderEphemeralPublicKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: "A".repeat(43),
    y: "A".repeat(43),
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  current = true;
  mocks.bootstrap.mockResolvedValue({
    userId: "owner",
    keyId: "owner-key",
    publicKeyJwk: { kty: "EC" },
  });
  mocks.seal.mockImplementation(async (args) => envelope(args.recipientKeyId));
});

it("binds both sealed copies to the confirmed request, participants, purpose and seven-day duration", async () => {
  const body = await AdvisorReviewService.prepare(
    context,
    candidate,
    snapshot,
    "Please review my portfolio.",
  );
  expect(body.approval).toBe("connect_and_share_finance_snapshot_v1");
  expect(body.durationSeconds).toBe(604800);
  expect(body.envelope.recipientKeyId).toBe("advisor-key");
  expect(body.ownerEnvelope.recipientKeyId).toBe("owner-key");
  expect(mocks.seal.mock.calls.map(([args]) => args.context)).toEqual([
    advisorSnapshotContext(body.requestId, "owner", "advisor"),
    advisorSnapshotContext(body.requestId, "owner", "advisor"),
  ]);
  expect(JSON.stringify(body)).not.toContain("Synthetic company");
  expect(JSON.stringify(body)).not.toContain("Technology");
  expect(mocks.api).not.toHaveBeenCalled();
});

it("does not publish or return a prepared payload after the vault session retires", async () => {
  mocks.seal.mockImplementationOnce(async (args) => {
    current = false;
    return envelope(args.recipientKeyId);
  });
  await expect(
    AdvisorReviewService.prepare(context, candidate, snapshot, ""),
  ).rejects.toThrow(/session changed/);
  expect(mocks.api).not.toHaveBeenCalled();
});

it("refuses a recipient without a registered secure key before encryption", async () => {
  await expect(
    AdvisorReviewService.prepare(
      context,
      { ...candidate, ready: false },
      snapshot,
      "",
    ),
  ).rejects.toThrow(/unlock One/);
  expect(mocks.bootstrap).not.toHaveBeenCalled();
  expect(mocks.seal).not.toHaveBeenCalled();
});

it("retains the HTTP refusal class so the flow can distinguish definite rejection from an uncertain send", async () => {
  mocks.api.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ detail: { code: "FINANCE_SHARE_KEY_CHANGED" } }),
  });
  const body = await AdvisorReviewService.prepare(
    context,
    candidate,
    snapshot,
    "",
  );
  await expect(AdvisorReviewService.send(context, body)).rejects.toMatchObject({
    code: "FINANCE_SHARE_KEY_CHANGED",
    status: 409,
  });
  expect(new AdvisorReviewError("ADVISOR_CONNECT_CALENDAR").message).toMatch(
    /Connect Google Calendar/,
  );
  expect(new AdvisorReviewError("ADVISOR_CONNECT_STRIPE").message).toMatch(
    /Stripe payout setup/,
  );
});
