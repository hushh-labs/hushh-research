import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), ownerPodRequest: vi.fn(), privateOwner: vi.fn(), current: true }));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionPrincipal: () => ({ ownerId: "owner", firebaseUid: "firebase-owner" }), isValidatedAuthSessionOwnerCurrent: () => mocks.current }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 0, isVaultSessionEpochCurrent: () => mocks.current }));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({ ownerContentIsPrivate: mocks.privateOwner }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "firebase-owner" }) } }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch, ownerPodRequest: mocks.ownerPodRequest },
}));

import { AnswerRequestService } from "@/lib/services/answer-request-service";

const REQUEST = "11111111-2222-3333-4444-555555555555";

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  mocks.current = true;
  mocks.ownerPodRequest.mockReset();
  mocks.privateOwner.mockReset().mockResolvedValue(true);
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockResolvedValue(ok({ requestId: REQUEST }));
});

// The reported incident: the Request scope CTA was said to have produced a
// Google Drive document request for the recipient. Cloud Run logs showed this
// endpoint returning 200 and no Drive request existing at all, so the lane
// boundary is pinned here at the transport the CTA actually calls.
describe("Request scope submits to its own lane", () => {
  it("posts the question to the answer-request endpoint, never a Drive one", async () => {
    const result = await AnswerRequestService.create("id-token", "person-ref", {
      question: "What is your age?",
    });

    expect(result).toEqual({ requestId: REQUEST });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [path, options] = mocks.apiFetch.mock.calls[0];
    expect(path).toBe("/api/one/answer-requests");
    expect(options.method).toBe("POST");
    // Lane separation: no Drive, document or file transport is reachable from
    // this CTA, whatever the question happens to be about.
    expect(path).not.toMatch(/drive|document|file/i);
    expect(JSON.parse(options.body)).toMatchObject({
      personRef: "person-ref",
      question: "What is your age?",
    });
  });

  it("sends a question with no dates, because this lane has none", async () => {
    // The Drive lane requires an exact start and end date. Carrying that rule
    // across would have made a question about a person's memory unsendable.
    await AnswerRequestService.create("id-token", "person-ref", {
      question: "What is your age?",
    });
    const body = JSON.parse(mocks.apiFetch.mock.calls[0][1].body);
    expect(body.periodStart ?? null).toBeNull();
    expect(body.periodEnd ?? null).toBeNull();
  });

  it("refuses an unusable question before any request is made", async () => {
    await expect(
      AnswerRequestService.create("id-token", "person-ref", { question: "hi" }),
    ).rejects.toThrow();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

const projection = { memory: "Synthetic approved trip.", values: { "attr.travel.trips": { trips: ["Tokyo"] } } };
const written = { answerMode: "agent", answer: "Tokyo.", covers: ["attr.travel.trips"], gaps: [], compositionReceipt: "v2.synthetic.receipt" };

it("sends a private PKM projection only to its admitted owner pod", async () => {
  mocks.ownerPodRequest.mockResolvedValue(ok(written));
  await expect(AnswerRequestService.compose("token", REQUEST, projection)).resolves.toMatchObject({ answer: "Tokyo." });
  expect(mocks.apiFetch).not.toHaveBeenCalled();
  expect(mocks.ownerPodRequest).toHaveBeenCalledTimes(1);
  const [route, init] = mocks.ownerPodRequest.mock.calls[0];
  expect(route).toBe("answers/compose");
  expect(JSON.parse(init.body)).toEqual({ requestId: REQUEST, projection });
});

it("keeps confirmed Shared preparation on the configured hub runtime", async () => {
  mocks.privateOwner.mockResolvedValue(false);
  mocks.apiFetch.mockResolvedValue(ok(written));
  await AnswerRequestService.compose("token", REQUEST, projection);
  expect(mocks.apiFetch.mock.calls[0][0]).toBe(`/api/one/answer-requests/${REQUEST}/compose`);
  expect(mocks.ownerPodRequest).not.toHaveBeenCalled();
});

it.each([{}, { ...written, compositionReceipt: undefined }, { answerMode: "projection", answer: null }])("refuses malformed or failed preparation without projection fallback: %o", async body => {
  mocks.ownerPodRequest.mockResolvedValue(ok(body));
  await expect(AnswerRequestService.compose("token", REQUEST, projection)).rejects.toMatchObject({ name: "AnswerPreparationError" });
  expect(mocks.ownerPodRequest).toHaveBeenCalledTimes(1);
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});

it("does not replay a lost success body and refuses an owner change during placement lookup", async () => {
  mocks.ownerPodRequest.mockResolvedValue({ ok: true, json: async () => { throw new Error("synthetic connection lost"); } });
  await expect(AnswerRequestService.compose("token", REQUEST, projection)).rejects.toMatchObject({ name: "AnswerPreparationError" });
  expect(mocks.ownerPodRequest).toHaveBeenCalledTimes(1);
  mocks.ownerPodRequest.mockClear();
  mocks.privateOwner.mockImplementationOnce(async () => { mocks.current = false; return true; });
  await expect(AnswerRequestService.compose("token", REQUEST, projection)).rejects.toMatchObject({ name: "AnswerPreparationError" });
  expect(mocks.ownerPodRequest).not.toHaveBeenCalled();
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});

it("keeps unconfirmed ciphertext staging out of automatic model replay", async () => {
  mocks.apiFetch.mockRejectedValue(new Error("synthetic acknowledgment lost"));
  await expect(AnswerRequestService.deliver("token", REQUEST, { envelope: {}, hasContent: true })).rejects.toMatchObject({ name: "AnswerPreparationError" });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  expect(mocks.apiFetch.mock.calls[0][1].authRefreshRetry).toBe("never");
});
