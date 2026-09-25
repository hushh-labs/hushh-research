import { describe, expect, it, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({ nativeStreamFetch: vi.fn() }));

vi.mock("@/lib/services/native-sse-fetch", () => streamMocks);

import { GmailInformationRequestsService } from "@/lib/services/gmail-information-requests-service";

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
