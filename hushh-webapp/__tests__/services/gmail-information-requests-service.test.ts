import { describe, expect, it, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({ nativeStreamFetch: vi.fn() }));
const apiMocks = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock("@/lib/services/native-sse-fetch", () => streamMocks);
vi.mock("@/lib/services/api-client", () => apiMocks);

import { GmailInformationRequestsService } from "@/lib/services/gmail-information-requests-service";

describe("GmailInformationRequestsService reviewed reply delivery", () => {
  const input = { firebaseIdToken: "firebase-token", vaultOwnerToken: "vault-owner-token", workflowId: "workflow-1", body: "Exact reply" };
  it("retains the prepared sender binding and requires a matching verified send outcome", async () => {
    apiMocks.apiJson.mockResolvedValueOnce({ action_id: "action-1", expires_at: null, sender_token: "sender-binding", preview: {
      to: ["recipient@example.com"], cc: [], bcc: [], subject: "Re: Request", gmail_thread_id: "thread-1",
    } });
    const prepared = await GmailInformationRequestsService.prepareReply({ ...input, idempotencyKey: "unit-test-key" });
    expect(prepared.senderToken).toBe("sender-binding");
    apiMocks.apiJson.mockResolvedValueOnce({ action_id: "action-1", state: "sent" });
    await expect(GmailInformationRequestsService.sendReply({ ...input, actionId: prepared.actionId, senderToken: prepared.senderToken }))
      .resolves.toEqual({ state: "sent", outcomeUnknown: false });
    expect(apiMocks.apiJson).toHaveBeenLastCalledWith("/api/one/email/send", expect.objectContaining({ body: JSON.stringify({
      action_id: "action-1", sender_token: "sender-binding", body: "Exact reply", html_body: null, source_workflow_id: "workflow-1",
    }) }));
    for (const response of [{}, { state: "sent" }, { action_id: "other", state: "sent" }, { action_id: "action-1", state: "sent", outcome_unknown: true }]) {
      apiMocks.apiJson.mockResolvedValueOnce(response);
      await expect(GmailInformationRequestsService.sendReply({ ...input, actionId: "action-1", senderToken: "sender-binding" }))
        .resolves.toEqual({ state: "outcome_unknown", outcomeUnknown: true });
    }
  });
});

function streamResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("GmailInformationRequestsService.scanStream", () => {
  it("reassembles fragmented metadata-only frames and delivers each request before completion", async () => {
    streamMocks.nativeStreamFetch.mockResolvedValue(
      streamResponse(
        'event: progress\ndata: {"event":"progress","scanned_count":2}\n\n' +
          'event: request\ndata: {"event":"request","workflow":{"workflow_id":"request-2",',
        '"status":"detected","gmail_thread_id":"thread-2","received_at":"2026-09-24T12:00:00.000Z","classification_confidence":0.9,"requested_field_labels":["Passport number"],"candidate_scopes":[],"attachment_review_required":false}}\n\n' +
          'event: complete\ndata: {"event":"complete","accepted":true,"scanned_count":2,"unchanged_count":0,"matched_count":1,"failed_count":0,"workflow_ids":["request-2"]}\n\n',
      ),
    );
    const progress: number[] = [];
    const requests: string[] = [];

    const result = await GmailInformationRequestsService.scanStream({
      firebaseIdToken: "firebase-token",
      vaultOwnerToken: "vault-owner-token",
      maxResults: 5,
      handlers: {
        onProgress: (count) => progress.push(count),
        onRequest: (workflow) => requests.push(workflow.workflow_id),
      },
    });

    expect(progress).toEqual([2]);
    expect(requests).toEqual(["request-2"]);
    expect(result).toMatchObject({ scanned_count: 2, workflow_ids: ["request-2"] });
    expect(streamMocks.nativeStreamFetch).toHaveBeenCalledWith(
      "/api/one/email/information-requests/scan/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer firebase-token",
          "X-Hushh-Consent": "Bearer vault-owner-token",
        }),
        body: JSON.stringify({ max_results: 5, include_recent_inbox: false }),
      }),
    );
  });
});
