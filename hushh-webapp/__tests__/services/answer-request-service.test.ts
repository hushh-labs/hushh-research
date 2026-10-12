import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));

import { AnswerRequestService } from "@/lib/services/answer-request-service";

const REQUEST = "11111111-2222-3333-4444-555555555555";

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
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
