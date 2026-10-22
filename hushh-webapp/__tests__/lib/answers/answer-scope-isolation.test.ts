import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentExportForScope, getStaleFirst, answerable, compose, deliver, encrypt, work, params, resetAnswerFixture, setScopeProjection } from "./fixtures";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { buildAnswerPayload, runAnswerDeliverySweep } from "@/lib/answers/answer-delivery-sweep";
import { projectApprovedAnswer } from "@/lib/answers/answer-projection";
beforeEach(resetAnswerFixture);

describe("an approved field cannot expose another field in the same domain", () => {
  it("asks for the exact approved scope and never reads the domain", async () => {
    setScopeProjection({
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
    expect(Object.keys(payload.approvedInformation)).toEqual([
      "attr.travel.trips",
    ]);
  });

  it("drops a sibling projection the owner never approved", async () => {
    // Simulate a caller (or a future bug) producing more than was approved:
    // the projection step must still refuse it.
    const projected = projectApprovedAnswer({
      approvedScopes: ["attr.travel.trips"],
      projections: [
        {
          scope: "attr.travel.trips",
          payload: { trips: ["Tokyo"] },
          contentRevision: 7,
        },
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
      .mockResolvedValueOnce({
        payload: { trips: ["Tokyo"] },
        sourceContentRevision: 7,
      })
      .mockRejectedValueOnce(new Error("no longer available to share"));

    const { payload } = await buildAnswerPayload(
      work({ approvedScopes: ["attr.travel.trips", "attr.preferences.food"] }),
      params,
    );

    expect(Object.keys(payload.approvedInformation)).toEqual([
      "attr.travel.trips",
    ]);
    expect(payload.unavailableScopes).toEqual(["attr.preferences.food"]);
  });

  it("reports no content when every approved scope is empty, so the order refunds", async () => {
    setScopeProjection({
      payload: {},
      sourceContentRevision: 7,
    });
    const { hasContent } = await buildAnswerPayload(work(), params);
    expect(hasContent).toBe(false);
  });
});

describe("the requested period is applied before the answer is sealed", () => {
  it("drops dated records outside the window and counts them", async () => {
    setScopeProjection({
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

    const trips = (
      payload.approvedInformation["attr.travel.trips"] as {
        trips: { city: string }[];
      }
    ).trips;
    expect(trips.map((trip) => trip.city)).toEqual(["Tokyo"]);
    expect(payload.excludedByPeriod).toBe(2);
    expect(payload.period).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("keeps undated records rather than guessing they fall outside", async () => {
    // Removing a record whose date this code cannot read would silently drop
    // information the owner agreed to share.
    setScopeProjection({
      payload: {
        trips: [{ city: "Tokyo" }, { date: "2020-01-01", city: "Osaka" }],
      },
      sourceContentRevision: 7,
    });

    const { payload } = await buildAnswerPayload(
      work({ periodStart: "2026-01-01", periodEnd: "2026-12-31" }),
      params,
    );

    const trips = (
      payload.approvedInformation["attr.travel.trips"] as {
        trips: { city: string }[];
      }
    ).trips;
    expect(trips.map((trip) => trip.city)).toEqual(["Tokyo"]);
    expect(payload.excludedByPeriod).toBe(1);
  });

  it("leaves everything in place when no period was requested", async () => {
    setScopeProjection({
      payload: { trips: [{ date: "2019-01-01", city: "Osaka" }] },
      sourceContentRevision: 7,
    });
    const { payload } = await buildAnswerPayload(work(), params);
    const trips = (
      payload.approvedInformation["attr.travel.trips"] as {
        trips: { city: string }[];
      }
    ).trips;
    expect(trips).toHaveLength(1);
    expect(payload.excludedByPeriod).toBe(0);
  });
});

describe("a failed answer is retried and refunded, never counted as delivered", () => {
  it("leaves the request queued when the writer failed but the information exists", async () => {
    // The owner's information CAN answer the question; the answer gene did
    // not. Delivering the raw records would mark the request answered and pay
    // the owner for work the requester never received.
    setScopeProjection({
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

  it("refuses a mocked successful composer result that reports an unanswered gap", async () => {
    setScopeProjection({ payload: { trips: [{ city: "Tokyo", amount: 1200 }] }, sourceContentRevision: 7 });
    answerable.mockResolvedValue([work()]);
    compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Only part of the question is answered.", covers: ["attr.travel.trips"], gaps: ["Missing part of the requested answer."] });
    expect(await runAnswerDeliverySweep({ ...params, firebaseIdToken: "id-token" })).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
    expect(encrypt).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("still delivers when there is genuinely nothing to say, so the order refunds", async () => {
    // An empty answer is not a failed answer: the delivery records that there
    // was nothing in the approved scopes, and the backend refunds it.
    setScopeProjection({
      payload: {},
      sourceContentRevision: 7,
    });
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

  it("never calls an unreadable scope an absent answer", async () => {
    // The vault was locked, the manifest was stale, the network blipped --
    // whatever it was, nothing was read. Delivering empty here would tell the
    // requester the answer does not exist, refuse their payment for good, and
    // do it on evidence that was never gathered. It stays queued instead.
    buildConsentExportForScope.mockRejectedValue(new Error("vault locked"));
    answerable.mockResolvedValue([work()]);

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
  });

  it("sends Gemini only approved travel, without unapproved account identity", async () => {
    setScopeProjection({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });
    answerable.mockResolvedValue([work()]);
    compose.mockResolvedValue({
      answerMode: "agent", compositionReceipt: "synthetic-composition-receipt",
      answer: "Tokyo.",
      covers: [],
      gaps: [],
    });

    await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: {
        displayName: "Smirthika Dharmalingam",
        email: "smirthika@example.com",
        photoUrl: "https://example.com/photo.jpg",
      },
    });

    const projection = JSON.stringify(compose.mock.calls[0]![2]);
    expect(projection).toContain("Tokyo");
    expect(projection).not.toContain("Smirthika Dharmalingam");
    expect(projection).not.toContain("smirthika@example.com");
    expect(projection).not.toContain("https://example.com/photo.jpg");
    expect(projection).not.toContain("Profile photo included");
  });

  it("delivers a written answer", async () => {
    setScopeProjection({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });
    answerable.mockResolvedValue([work()]);
    compose.mockResolvedValue({
      answerMode: "agent", compositionReceipt: "synthetic-composition-receipt",
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

describe("lock fences asynchronous answer work", () => {
  it.each(["export", "compose", "encrypt"].flatMap(stage =>
    ["vault lock", "account switch"].map(boundary => [stage, boundary] as const)))(
    "stops during %s after %s",
    async (stage) => {
      let release!: (value: never) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      answerable.mockResolvedValue([work()]);
      setScopeProjection({
        payload: { trips: [{ city: "Tokyo" }] },
      });
      compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "One trip." });
      const selected =
        stage === "export"
          ? buildConsentExportForScope
          : stage === "compose"
            ? compose
            : encrypt;
      selected.mockReturnValue(pending);
      const sweep = runAnswerDeliverySweep({
        ...params,
        firebaseIdToken: "token",
      });
      await vi.waitFor(() => expect(selected).toHaveBeenCalled());
      // Both custody boundaries advance the same application generation;
      // the already-started owner task must never stage its plaintext.
      advanceVaultSessionEpoch();
      release(
        (stage === "export"
          ? { payload: { trips: [{ city: "Tokyo" }] } }
          : stage === "compose"
            ? { answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "One trip." }
            : { sealed: "ciphertext" }) as never,
      );
      await sweep;
      expect(deliver).not.toHaveBeenCalled();
      if (stage === "export") expect(compose).not.toHaveBeenCalled();
      if (stage !== "encrypt") expect(encrypt).not.toHaveBeenCalled();
    },
  );
});

it("concurrent owner preparation joins one composition and one encrypted stage", async () => {
  answerable.mockResolvedValue([work()]);
  setScopeProjection({ payload: { trips: [{ destination: "Synthetic city" }] }, sourceContentRevision: 7 });
  compose.mockResolvedValue({ answerMode: "agent", answer: "Synthetic city.", covers: [], gaps: [], compositionReceipt: "synthetic-composition-receipt" });
  encrypt.mockResolvedValue({ ciphertext: "synthetic" });
  deliver.mockResolvedValue(undefined);
  const selected = { ...params, firebaseIdToken: "id-token", requestId: work().requestId };
  const results = await Promise.all([runAnswerDeliverySweep(selected), runAnswerDeliverySweep(selected)]);
  expect(results.map(result => result.delivered)).toEqual([1, 1]);
  expect(compose).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("times out visibly and never stages a late Gemini result", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  try {
    answerable.mockResolvedValue([work()]);
    setScopeProjection({ payload: { trips: [{ destination: "Synthetic city" }] }, sourceContentRevision: 7 });
    compose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runAnswerDeliverySweep({ ...params, firebaseIdToken: "id-token", requestId: work().requestId });
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    finish({ answerMode: "agent", answer: "Late answer", gaps: [], compositionReceipt: "synthetic-receipt" });
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
