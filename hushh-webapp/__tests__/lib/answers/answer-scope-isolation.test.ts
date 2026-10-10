import { beforeEach, describe, expect, it, vi } from "vitest";

const buildConsentExportForScope = vi.fn();
vi.mock("@/lib/consent/export-builder", () => ({
  buildConsentExportForScope: (...args: unknown[]) => buildConsentExportForScope(...args),
}));
// Reading a whole PKM domain is the bug this file exists to prevent. If the
// sweep ever reaches for the domain resource again, this mock records it.
const getStaleFirst = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: (...a: unknown[]) => getStaleFirst(...a) },
}));

const answerable = vi.fn();
const compose = vi.fn();
const deliver = vi.fn();
vi.mock("@/lib/services/answer-request-service", () => ({
  AnswerRequestService: {
    answerable: (...a: unknown[]) => answerable(...a),
    compose: (...a: unknown[]) => compose(...a),
    deliver: (...a: unknown[]) => deliver(...a),
  },
}));
vi.mock("@/lib/one-marketplace/encryption", () => ({
  encryptSliceForRecipient: async () => ({ sealed: "ciphertext" }),
}));

import { buildAnswerPayload, runAnswerDeliverySweep } from "@/lib/answers/answer-delivery-sweep";
import { projectApprovedAnswer } from "@/lib/answers/answer-projection";
import type { AnswerableWork } from "@/lib/services/answer-request-service";

const work = (overrides: Partial<AnswerableWork> = {}): AnswerableWork => ({
  requestId: "11111111-2222-3333-4444-555555555555",
  question: "How much did you spend on travel last year?",
  periodStart: null,
  periodEnd: null,
  approvedScopes: ["attr.travel.trips"],
  scopeLabels: {},
  answerDeadlineAt: null,
  requesterUserId: "requester-B",
  recipientKey: { keyId: "key-1", publicKeyJwk: {} as JsonWebKey },
  ...overrides,
});

const params = { userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token" };

beforeEach(() => {
  buildConsentExportForScope.mockReset();
  getStaleFirst.mockReset();
  answerable.mockReset();
  compose.mockReset();
  deliver.mockReset();
  compose.mockResolvedValue({ answerMode: "projection", answer: null });
  deliver.mockResolvedValue(undefined);
});

describe("an approved field cannot expose another field in the same domain", () => {
  it("asks for the exact approved scope and never reads the domain", async () => {
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });

    const { payload } = await buildAnswerPayload(work(), params);

    // The exact scope was requested, not its domain.
    expect(buildConsentExportForScope).toHaveBeenCalledTimes(1);
    expect(buildConsentExportForScope.mock.calls[0]![0]).toMatchObject({
      scope: "attr.travel.trips",
      userId: "owner-A",
    });
    // The whole-domain read path is never touched. This is the regression:
    // reading `travel` wholesale is what leaked siblings.
    expect(getStaleFirst).not.toHaveBeenCalled();
    expect(Object.keys(payload.approvedInformation)).toEqual(["attr.travel.trips"]);
  });

  it("drops a sibling projection the owner never approved", async () => {
    // Simulate a caller (or a future bug) producing more than was approved:
    // the projection step must still refuse it.
    const projected = projectApprovedAnswer({
      approvedScopes: ["attr.travel.trips"],
      projections: [
        { scope: "attr.travel.trips", payload: { trips: ["Tokyo"] }, contentRevision: 7 },
        {
          scope: "attr.travel.passport_notes",
          payload: { passport_notes: "P<IND1234567" },
          contentRevision: 7,
        },
      ],
      period: null,
    });

    expect(Object.keys(projected.byScope)).toEqual(["attr.travel.trips"]);
    expect(JSON.stringify(projected)).not.toContain("P<IND1234567");
  });

  it("names a scope that could not be exported instead of quietly omitting it", async () => {
    buildConsentExportForScope
      .mockResolvedValueOnce({ payload: { trips: ["Tokyo"] }, sourceContentRevision: 7 })
      .mockRejectedValueOnce(new Error("no longer available to share"));

    const { payload } = await buildAnswerPayload(
      work({ approvedScopes: ["attr.travel.trips", "attr.preferences.food"] }),
      params,
    );

    expect(Object.keys(payload.approvedInformation)).toEqual(["attr.travel.trips"]);
    expect(payload.unavailableScopes).toEqual(["attr.preferences.food"]);
  });

  it("reports no content when every approved scope is empty, so the order refunds", async () => {
    buildConsentExportForScope.mockResolvedValue({ payload: {}, sourceContentRevision: 7 });
    const { hasContent } = await buildAnswerPayload(work(), params);
    expect(hasContent).toBe(false);
  });
});

describe("the requested period is applied before the answer is sealed", () => {
  it("drops dated records outside the window and counts them", async () => {
    buildConsentExportForScope.mockResolvedValue({
      payload: {
        trips: [
          { date: "2026-03-04", city: "Tokyo" },
          { date: "2025-11-20", city: "Osaka" },
          { date: "2027-02-01", city: "Kyoto" },
        ],
      },
      sourceContentRevision: 7,
    });

    const { payload } = await buildAnswerPayload(
      work({ periodStart: "2026-01-01", periodEnd: "2026-12-31" }),
      params,
    );

    const trips = (payload.approvedInformation["attr.travel.trips"] as { trips: { city: string }[] }).trips;
    expect(trips.map((trip) => trip.city)).toEqual(["Tokyo"]);
    expect(payload.excludedByPeriod).toBe(2);
    expect(payload.period).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("keeps undated records rather than guessing they fall outside", async () => {
    // Removing a record whose date this code cannot read would silently drop
    // information the owner agreed to share.
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ city: "Tokyo" }, { date: "2020-01-01", city: "Osaka" }] },
      sourceContentRevision: 7,
    });

    const { payload } = await buildAnswerPayload(
      work({ periodStart: "2026-01-01", periodEnd: "2026-12-31" }),
      params,
    );

    const trips = (payload.approvedInformation["attr.travel.trips"] as { trips: { city: string }[] }).trips;
    expect(trips.map((trip) => trip.city)).toEqual(["Tokyo"]);
    expect(payload.excludedByPeriod).toBe(1);
  });

  it("leaves everything in place when no period was requested", async () => {
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ date: "2019-01-01", city: "Osaka" }] },
      sourceContentRevision: 7,
    });
    const { payload } = await buildAnswerPayload(work(), params);
    const trips = (payload.approvedInformation["attr.travel.trips"] as { trips: { city: string }[] }).trips;
    expect(trips).toHaveLength(1);
    expect(payload.excludedByPeriod).toBe(0);
  });
});

describe("a failed answer is retried and refunded, never counted as delivered", () => {
  it("leaves the request queued when the writer failed but the information exists", async () => {
    // The owner's information CAN answer the question; the answer gene did
    // not. Delivering the raw records would mark the request answered and pay
    // the owner for work the requester never received.
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });
    answerable.mockResolvedValue([work()]);
    compose.mockRejectedValue(new Error("gene unavailable"));

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
  });

  it("still delivers when there is genuinely nothing to say, so the order refunds", async () => {
    // An empty answer is not a failed answer: the delivery records that there
    // was nothing in the approved scopes, and the backend refunds it.
    buildConsentExportForScope.mockResolvedValue({ payload: {}, sourceContentRevision: 7 });
    answerable.mockResolvedValue([work()]);

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
    expect(result).toMatchObject({ empty: 1, retry: 0, delivered: 0 });
  });

  it("delivers a written answer", async () => {
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });
    answerable.mockResolvedValue([work()]);
    compose.mockResolvedValue({
      answerMode: "agent",
      answer: "You spent $1,200 on travel, on one trip to Tokyo.",
      covers: ["attr.travel.trips"],
      gaps: [],
    });

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(result).toMatchObject({ delivered: 1, retry: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
