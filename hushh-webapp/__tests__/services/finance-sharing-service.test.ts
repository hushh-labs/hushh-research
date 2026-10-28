import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), directory: vi.fn(), bootstrap: vi.fn(), seal: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.api } }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listRecipientsPage: mocks.directory } }));
vi.mock("@/lib/one-location/key-bootstrap", () => ({ bootstrapCurrentUserLocationRecipientKey: mocks.bootstrap }));
vi.mock("@/lib/one-location/encryption", () => ({ sealRecipientPayload: mocks.seal }));
import { clearPendingFinanceShares, FinanceSharingService, pendingFinanceShare, type FinanceShareContext, type PreparedFinanceShare } from "@/lib/services/finance-sharing-service";
import type { FinanceGrant, FinanceProjection } from "@/lib/finance-sharing/contract";

const ref = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const envelope = (recipientKeyId: string) => ({ algorithm: "ECDH-P256-AES256-GCM" as const, recipientKeyId, iv: "A".repeat(16), ciphertext: "A".repeat(64), senderEphemeralPublicKeyJwk: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) } });
const policy = { version: 1 as const, mode: "ongoing" as const, sections: ["allocation" as const], selectionHash: "a".repeat(64), showAmounts: false, model_processing: { version: 1 as const, allowed: false }, durationSeconds: null };
const grant: FinanceGrant = { id, requestId, ownerUserId: "owner", recipientUserId: "recipient", recipientPersonRef: ref, recipientKeyId: "recipient-key", senderName: "Owner", recipientName: "Recipient", policy,
  revision: 1, contentHash: "b".repeat(64), createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z", serverNow: "2026-10-27T10:00:00Z", expiresAt: null, status: "active", direction: "outgoing", envelope: envelope("owner-key") };
const projection: FinanceProjection = { schema: "finance-share-v1", source: "statement", sourcePeriod: null, allocation: [{ name: "Equities", percent: 80 }] };
let current = true;
const context: FinanceShareContext = { userId: "owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner", getIdToken: async () => "synthetic-identity", isCurrent: () => current };
beforeEach(() => {
  vi.resetAllMocks(); current = true; clearPendingFinanceShares("owner"); vi.stubGlobal("crypto", webcrypto);
  mocks.directory.mockResolvedValue({ items: [{ userId: "recipient", publicPersonRef: ref, keyId: "recipient-key", publicKeyJwk: { kty: "EC" } }], page: 1, hasMore: false });
  mocks.bootstrap.mockResolvedValue({ userId: "owner", keyId: "owner-key", publicKeyJwk: { kty: "EC" } });
  mocks.seal.mockImplementation(async args => envelope(args.recipientKeyId));
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ revision: 2 }) });
  vi.spyOn(FinanceSharingService, "decrypt").mockResolvedValue({ ...projection, allocation: [{ name: "Equities", percent: 70 }], commitmentNonce: "f".repeat(64) });
});

describe("Finance encrypted publication", () => {
  it("keeps a revision stable when only its encrypted commitment salt differs", async () => {
    vi.mocked(FinanceSharingService.decrypt).mockResolvedValueOnce({ ...projection, commitmentNonce: "e".repeat(64) });
    await FinanceSharingService.refresh(context, grant, projection);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });
  it("refreshes to the recipient key even though the owner-view envelope is encrypted to the owner", async () => {
    await FinanceSharingService.refresh(context, grant, projection);
    const [path, options] = mocks.api.mock.calls[0]!;
    expect(path).toContain(id);
    const sent = JSON.parse(options.body);
    expect(sent.envelope.recipientKeyId).toBe("recipient-key");
    expect(sent.ownerEnvelope.recipientKeyId).toBe("owner-key");
    expect(sent.expectedRevision).toBe(1);
    expect(JSON.stringify(options)).not.toContain("Equities");
  });
  it("keeps the original encrypted request identity after an uncertain acknowledgement and refuses a different send", async () => {
    const body: PreparedFinanceShare = { requestId, policy, ownerConfig: envelope("owner-key"), recipients: [{ personRef: ref, grantId: id, envelope: envelope("recipient-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) }] };
    mocks.api.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(FinanceSharingService.publish(context, body)).rejects.toThrow();
    expect(pendingFinanceShare(context)).toBe(body);
    await expect(FinanceSharingService.publish(context, { ...body, requestId: "different" })).rejects.toThrow(/previous/);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [grant] }) });
    expect((await FinanceSharingService.publish(context, body)).items[0]?.id).toBe(id);
    expect(mocks.api.mock.calls[0]![1].body).toBe(mocks.api.mock.calls[1]![1].body);
    expect(pendingFinanceShare(context)).toBeNull();
  });
  it("does not confirm a receipt for a different grant, key, or content", async () => {
    const body: PreparedFinanceShare = { requestId, policy, ownerConfig: envelope("owner-key"), recipients: [{ personRef: ref, grantId: id, envelope: envelope("recipient-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) }] };
    for (const altered of [
      { ...grant, id: "44444444-4444-4444-8444-444444444444" },
      { ...grant, recipientKeyId: "wrong-key" },
      { ...grant, contentHash: "c".repeat(64) },
    ]) {
      clearPendingFinanceShares("owner");
      mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [altered] }) });
      await expect(FinanceSharingService.publish(context, body)).rejects.toThrow(/receipt/);
      expect(pendingFinanceShare(context)).toBe(body);
    }
  });
  it("rejects duplicate receipts in a multi-recipient confirmation", async () => {
    const body: PreparedFinanceShare = { requestId, policy, ownerConfig: envelope("owner-key"), recipients: [
      { personRef: ref, grantId: id, envelope: envelope("recipient-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) },
      { personRef: "55555555-5555-4555-8555-555555555555", grantId: "44444444-4444-4444-8444-444444444444", envelope: envelope("other-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) },
    ] };
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [grant, grant] }) });
    await expect(FinanceSharingService.publish(context, body)).rejects.toThrow(/receipt/);
    expect(pendingFinanceShare(context)).toBe(body);
  });
  it("reconciles a lost acknowledgement after an ongoing share has refreshed", async () => {
    const body: PreparedFinanceShare = { requestId, policy, ownerConfig: envelope("owner-key"), recipients: [{ personRef: ref, grantId: id, envelope: envelope("recipient-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) }] };
    const refreshed = { ...grant, revision: 2, contentHash: "c".repeat(64) };
    mocks.api.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(FinanceSharingService.publish(context, body)).rejects.toThrow();
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [refreshed] }) });
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => refreshed });
    expect((await FinanceSharingService.publish(context, body)).items[0]?.revision).toBe(2);
    expect(pendingFinanceShare(context)).toBeNull();
  });
  it("keeps the pending confirmation if a follow-up access check fails after POST", async () => {
    const body: PreparedFinanceShare = { requestId, policy, ownerConfig: envelope("owner-key"), recipients: [{ personRef: ref, grantId: id, envelope: envelope("recipient-key"), ownerEnvelope: envelope("owner-key"), contentHash: "b".repeat(64) }] };
    const refreshed = { ...grant, revision: 2, contentHash: "c".repeat(64) };
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [refreshed] }) });
    mocks.api.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ detail: "FINANCE_SHARE_UNAVAILABLE" }) });
    await expect(FinanceSharingService.publish(context, body)).rejects.toThrow();
    expect(pendingFinanceShare(context)).toBe(body);
  });
  it("discards a JSON read that completes after owner retirement", async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => { current = false; return { items: [], nextCursor: null }; } });
    await expect(FinanceSharingService.history(context)).rejects.toThrow(/session changed/);
  });
});
