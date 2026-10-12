import { beforeEach, describe, expect, it, vi } from "vitest";

const buildConsentExportForScope = vi.fn();
vi.mock("@/lib/consent/export-builder", () => ({
  createConsentExportReadSession: () => undefined,
  buildConsentExportForScope: (...args: unknown[]) =>
    buildConsentExportForScope(...args),
}));
// Reading a whole PKM domain is the bug this file exists to prevent. If the
// sweep ever reaches for the domain resource again, this mock records it.
const getStaleFirst = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: (...a: unknown[]) => getStaleFirst(...a),
  },
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
const loadMarkdownMemory = vi.fn();
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: (...a: unknown[]) => loadMarkdownMemory(...a),
}));
const encrypt = vi.fn();
vi.mock("@/lib/one-marketplace/encryption", () => ({
  encryptSliceForRecipient: (...a: unknown[]) => encrypt(...a),
}));
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

import {
  buildAnswerPayload,
  runAnswerDeliverySweep,
} from "@/lib/answers/answer-delivery-sweep";
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
  loadMarkdownMemory.mockReset();
  loadMarkdownMemory.mockResolvedValue(null);
  encrypt.mockReset().mockResolvedValue({ sealed: "ciphertext" });
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
    buildConsentExportForScope.mockResolvedValue({
      payload: {},
      sourceContentRevision: 7,
    });
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
    buildConsentExportForScope.mockResolvedValue({
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
    buildConsentExportForScope.mockResolvedValue({
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
    buildConsentExportForScope.mockResolvedValue({
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

  it("carries the owner's own name and photo into the answer document", async () => {
    // The requester already sees these on the profile they asked from, and
    // without them a question like "what is your name" had no name to answer
    // from even with Identity information approved.
    buildConsentExportForScope.mockResolvedValue({
      payload: { trips: [{ city: "Tokyo", amount: 1200 }] },
      sourceContentRevision: 7,
    });
    answerable.mockResolvedValue([work()]);
    compose.mockResolvedValue({
      answerMode: "agent",
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

    const memory = String(compose.mock.calls[0]![2].memory);
    expect(memory).toContain("Smirthika Dharmalingam");
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

describe("lock fences asynchronous answer work", () => {
  it.each(["export", "compose", "encrypt"])(
    "stops after lock during %s",
    async (stage) => {
      let release!: (value: never) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      answerable.mockResolvedValue([work()]);
      buildConsentExportForScope.mockResolvedValue({
        payload: { trips: [{ city: "Tokyo" }] },
      });
      compose.mockResolvedValue({ answerMode: "agent", answer: "One trip." });
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
      advanceVaultSessionEpoch();
      release(
        (stage === "export"
          ? { payload: { trips: [{ city: "Tokyo" }] } }
          : stage === "compose"
            ? { answerMode: "agent", answer: "One trip." }
            : { sealed: "ciphertext" }) as never,
      );
      await sweep;
      expect(deliver).not.toHaveBeenCalled();
      if (stage === "export") expect(compose).not.toHaveBeenCalled();
      if (stage !== "encrypt") expect(encrypt).not.toHaveBeenCalled();
    },
  );
});

// The identity intake writes what the person states as labelled Soul bullets,
// so these are the paths a real "what is your name" / "what is your age"
// request actually has to read.
describe("identity facts recorded in Soul.md answer the question they were approved for", () => {
  const SOUL = [
    "## Facts",
    "",
    "- Legal name: Smirthika Dharmalingam",
    "- Date of birth: 1998-03-14",
    "- Sex: female",
    "- Saving for a trip to Kyoto",
    "",
  ].join("\n");

  const identityWork = (scope: string) =>
    work({ approvedScopes: [scope], question: "What is your age?" });

  beforeEach(() => {
    loadMarkdownMemory.mockResolvedValue({ markdown: SOUL, dataVersion: 12 });
    // No structured leaf exists for these; Soul.md is the only source.
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
  });

  it("puts the age, not the birth date, into what the writer is given", async () => {
    const { payload, hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );

    expect(hasContent).toBe(true);
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("declared_age");
    // The birth date is its own approval and was not given here.
    expect(rendered).not.toContain("1998-03-14");
    expect(payload.sourceRevisions["attr.identity.identity_profile.declared_age"]).toBe(12);
  });

  it("answers a name request from the recorded legal name", async () => {
    const { payload, hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.full_name"),
      params,
    );
    expect(hasContent).toBe(true);
    expect(JSON.stringify(payload)).toContain("Smirthika Dharmalingam");
  });

  it("carries no unapproved fact and none of the surrounding prose", async () => {
    const { payload } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );
    const rendered = JSON.stringify(payload);
    expect(rendered).not.toContain("female");
    expect(rendered).not.toContain("Kyoto");
    expect(rendered).not.toContain("Smirthika Dharmalingam");
  });

  it("stays pending when the Soul document cannot be read", async () => {
    // Locked or failed: not an absent fact, so it must not deliver "not found".
    loadMarkdownMemory.mockRejectedValue(new Error("vault locked"));
    const { payload } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );
    expect(payload.unavailableScopes).toContain(
      "attr.identity.identity_profile.declared_age",
    );
  });

  it("says nothing rather than guessing a sex that was never recorded", async () => {
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- She prefers window seats\n",
      dataVersion: 3,
    });
    const { hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.sex"),
      params,
    );
    expect(hasContent).toBe(false);
  });
});

describe("the three outcomes of preparing an answer, at staging level", () => {
  const AGE = "attr.identity.identity_profile.declared_age";

  const sweep = () =>
    runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: {
        displayName: "Smirthika Dharmalingam",
        photoUrl: "https://example.test/photo.png",
      },
    });

  const askAge = () =>
    answerable.mockResolvedValue([
      work({ approvedScopes: [AGE], question: "What is your age?" }),
    ]);

  it("stages nothing and stays retryable when the document cannot be read", async () => {
    // Locked, stale or denied: not an answer in either direction.
    loadMarkdownMemory.mockRejectedValue(new Error("vault locked"));
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    askAge();

    const result = await sweep();

    expect(deliver).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
  });

  it("settles a fact nobody recorded as absent, so it is answered not retried", async () => {
    // The document read SUCCEEDED and the fact is simply not in it. That is a
    // verified absence -- an answer -- and it used to sit unreadable for ever.
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 12,
    });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    askAge();

    const result = await sweep();

    expect(deliver).toHaveBeenCalledTimes(1);
    // "Answer not found", and checkout refuses an empty staged answer.
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
    expect(result).toMatchObject({ empty: 1, retry: 0, delivered: 0 });
  });

  it("does not let the account name or photo make a missing age chargeable", async () => {
    // Both are carried into the document's Account section for every answer.
    // If they counted as content, an age nobody recorded would be sold.
    loadMarkdownMemory.mockResolvedValue({ markdown: "## Facts\n", dataVersion: 12 });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    askAge();

    await sweep();

    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
  });
});

describe("a Soul-backed fact is finished work, not a failed read", () => {
  const SOUL = "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- Date of birth: 1998-03-14\n";

  it("composes and stages when the structured leaf is simply absent", async () => {
    // Identity facts have no structured leaf at all, so the per-scope export
    // always fails for them. If that counts as an unreadable scope the request
    // retries for ever and the answer is never staged, even though the fact
    // was read successfully from the document.
    loadMarkdownMemory.mockResolvedValue({ markdown: SOUL, dataVersion: 12 });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    compose.mockResolvedValue({
      answerMode: "agent",
      answer: "She is 27.",
      covers: ["attr.identity.identity_profile.declared_age"],
      gaps: [],
    });
    encrypt.mockResolvedValue({ ciphertext: "sealed" });
    answerable.mockResolvedValue([
      work({
        approvedScopes: ["attr.identity.identity_profile.declared_age"],
        question: "What is your age?",
      }),
    ]);

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(compose).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: true });
    expect(result).toMatchObject({ delivered: 1, retry: 0, empty: 0 });
  });
});

describe("which name answers a name request", () => {
  const NAME = "attr.identity.identity_profile.full_name";

  const ask = () =>
    answerable.mockResolvedValue([
      work({ approvedScopes: [NAME], question: "What is your name?" }),
    ]);

  beforeEach(() => {
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    compose.mockResolvedValue({ answerMode: "agent", answer: "Smirthika.", covers: [], gaps: [] });
    encrypt.mockResolvedValue({ ciphertext: "sealed" });
  });

  it("prefers the legal name the person stated over their account name", async () => {
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 9,
    });
    ask();

    await runAnswerDeliverySweep({
      userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: { displayName: "smiri" },
    });

    const values = JSON.stringify(compose.mock.calls[0]![2].values);
    expect(values).toContain("Smirthika Dharmalingam");
    expect(values).not.toContain("smiri");
  });

  it("falls back to the account name when no legal name was ever stated", async () => {
    // An owner who never completed the identity intake can still answer this.
    loadMarkdownMemory.mockResolvedValue({ markdown: "## Facts\n", dataVersion: 9 });
    ask();

    const result = await runAnswerDeliverySweep({
      userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: { displayName: "Smirthika D" },
    });

    expect(JSON.stringify(compose.mock.calls[0]![2].values)).toContain("Smirthika D");
    expect(result).toMatchObject({ delivered: 1, retry: 0, empty: 0 });
  });
});
