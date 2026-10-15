import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock("@/lib/services/api-client", () => ({
  apiJson: m.apiJson,
  apiErrorCode: (error: { code?: string }) => error.code ?? null,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }) },
}));

import {
  DocumentRequestPaymentSourceCapacityError,
  DocumentRequestPaymentSourceService,
  parseDocumentRequestPaymentSnapshot,
} from "@/lib/services/document-request-payment-source-service";

const T = "2026-10-15T00:00:00+00:00";
const ID = "11111111-1111-4111-8111-111111111111";
const row = () => ({
  requestId: ID,
  counterpartRef: `sub_${"a".repeat(32)}`,
  mode: "test",
  status: "paid",
  amountCents: 300,
  currency: "USD",
  paidAt: T,
  refundStatus: null,
  refundAmountCents: null,
  reconciliationRequired: false,
  createdAt: T,
  updatedAt: T,
  stripePaymentIntentId: "pi_must_not_persist",
  documentName: "must not persist",
  counterpartUserId: "raw-peer",
});
const response = (items: unknown[] = [row()]) => ({
  schemaVersion: 1,
  ownerUserId: "owner",
  sourceReadVerified: true,
  asOf: T,
  items,
});

describe("DocumentRequestPaymentSourceService", () => {
  beforeEach(() => m.apiJson.mockReset());

  it("uses the owner token and projects only verified allowlisted payment metadata", async () => {
    m.apiJson.mockResolvedValue(response());
    const rows = await DocumentRequestPaymentSourceService.snapshot("owner-token", "owner");
    expect(m.apiJson).toHaveBeenCalledWith(
      "/api/one/source-snapshots/document-request-payments",
      { method: "GET", headers: { Authorization: "Bearer owner-token" }, cache: "no-store" },
    );
    expect(rows).toEqual([{
      requestId: ID, counterpartRef: `sub_${"a".repeat(32)}`,
      mode: "test", status: "paid", amountCents: 300, currency: "USD",
      paidAt: T, refundStatus: null, refundAmountCents: null,
      reconciliationRequired: false, createdAt: T, updatedAt: T,
    }]);
    expect(JSON.stringify(rows)).not.toContain("pi_must_not_persist");
    expect(JSON.stringify(rows)).not.toContain("raw-peer");
  });

  it.each([
    ["wrong owner", { ownerUserId: "other" }],
    ["uncertified snapshot", { sourceReadVerified: false }],
    ["wrong version", { schemaVersion: 2 }],
    ["missing rows", { items: undefined }],
  ])("rejects %s", (_reason, change) => {
    expect(() => parseDocumentRequestPaymentSnapshot({ ...response(), ...change }, "owner"))
      .toThrow("incomplete");
  });

  it("rejects duplicate, malformed and over-cap rows instead of accepting a partial inventory", () => {
    expect(() => parseDocumentRequestPaymentSnapshot(response([row(), row()]), "owner"))
      .toThrow("invalid");
    expect(() => parseDocumentRequestPaymentSnapshot(response([{ ...row(), amountCents: null }]), "owner"))
      .toThrow("invalid");
    expect(() => parseDocumentRequestPaymentSnapshot(response([{ ...row(), counterpartRef: "raw-peer" }]), "owner"))
      .toThrow("invalid");
    expect(() => parseDocumentRequestPaymentSnapshot(response(Array(5_001).fill(row())), "owner"))
      .toThrow(DocumentRequestPaymentSourceCapacityError);
  });

  it("accepts a true empty snapshot and a partial refund state", () => {
    expect(parseDocumentRequestPaymentSnapshot(response([]), "owner")).toEqual([]);
    expect(parseDocumentRequestPaymentSnapshot(response([{
      ...row(), refundStatus: "pending", refundAmountCents: 100,
    }]), "owner")[0]).toMatchObject({ refundStatus: "pending", refundAmountCents: 100 });
    expect(parseDocumentRequestPaymentSnapshot(response([{
      ...row(), refundStatus: "queued", refundAmountCents: null,
    }]), "owner")[0]).toMatchObject({ refundStatus: "queued", refundAmountCents: null });
  });

  it("classifies only the server capacity code as a cooldown-worthy error", async () => {
    m.apiJson.mockRejectedValueOnce({ code: "SOURCE_CAPACITY_EXCEEDED" });
    await expect(DocumentRequestPaymentSourceService.snapshot("token", "owner"))
      .rejects.toBeInstanceOf(DocumentRequestPaymentSourceCapacityError);
    m.apiJson.mockRejectedValueOnce({ code: "SOURCE_UNAVAILABLE" });
    await expect(DocumentRequestPaymentSourceService.snapshot("token", "owner"))
      .rejects.toEqual({ code: "SOURCE_UNAVAILABLE" });
  });
});
