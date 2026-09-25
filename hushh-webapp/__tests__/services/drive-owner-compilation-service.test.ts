import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTransport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/services/native-sse-fetch", () => ({
  nativeStreamFetch: mockTransport.fetch,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }) },
}));

import {
  DriveCompilationError,
  streamOwnerDriveCompilation,
} from "@/lib/services/drive-owner-compilation-service";

function streamResponse(frames: string[], terminate = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const bytes = encoder.encode(frame);
        const midpoint = Math.floor(bytes.byteLength / 2);
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
      }
      if (terminate) controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function frame(event: string, payload: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`;
}

beforeEach(() => mockTransport.fetch.mockReset());

describe("owner Drive compilation stream", () => {
  const input = {
    token: "synthetic-owner", message: "Compile all 30 days standup notes",
    window: { start_date: "2026-08-27", end_date: "2026-09-25", timezone: "Asia/Kolkata" },
    guard: vi.fn(),
  };

  it("reports real file counts and releases Markdown only after the complete frame", async () => {
    const onStage = vi.fn();
    const onFile = vi.fn();
    mockTransport.fetch.mockResolvedValue(streamResponse([
      frame("stage", { phase: "starting" }),
      frame("stage", { phase: "searching" }),
      frame("stage", { phase: "fetching" }),
      frame("file", { phase: "fetching", completed: 1, total: 30, failed: 0,
        name: "PRIVATE_TITLE" }),
      frame("file", { phase: "fetching", completed: 2, total: 30, failed: 1 }),
      frame("markdown", { index: 0, text: "# Original notes\n" }),
      frame("markdown", { index: 1, text: "PRIVATE_CONTENT\n" }),
      frame("complete", { status: "partial", matched: 30, included: 29,
        failed: 1, truncated: false }),
    ]));

    const result = await streamOwnerDriveCompilation({ ...input, onStage, onFile });
    expect(result).toEqual({ markdown: "# Original notes\nPRIVATE_CONTENT\n",
      status: "partial", matched: 30, included: 29, failed: 1, truncated: false });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["starting", "searching", "fetching"]);
    expect(onFile.mock.calls).toEqual([
      [{ phase: "fetching", completed: 1, total: 30, failed: 0 }],
      [{ phase: "fetching", completed: 2, total: 30, failed: 1 }],
    ]);
    expect(JSON.stringify(onFile.mock.calls)).not.toContain("PRIVATE_TITLE");
    const [path, request] = mockTransport.fetch.mock.calls[0];
    expect(path).toBe("/api/connectors/google_drive/sharing/owner/compile/stream");
    expect(request.headers.Authorization).toBe("Bearer synthetic-owner");
    expect(JSON.parse(request.body)).toEqual({ message: input.message, window: input.window });
  });

  it("rejects an interrupted stream and never returns its partial Markdown", async () => {
    mockTransport.fetch.mockResolvedValue(streamResponse([
      frame("markdown", { index: 0, text: "PRIVATE_CONTENT" }),
    ]));
    await expect(streamOwnerDriveCompilation(input)).rejects.toMatchObject({
      code: "interrupted",
    });
  });

  it("rejects a missing or reordered Markdown chunk", async () => {
    mockTransport.fetch.mockResolvedValue(streamResponse([
      frame("markdown", { index: 1, text: "PRIVATE_CONTENT" }),
      frame("complete", { status: "complete", matched: 1, included: 1,
        failed: 0, truncated: false }),
    ]));
    await expect(streamOwnerDriveCompilation(input)).rejects.toBeInstanceOf(DriveCompilationError);
  });

  it("accepts a bounded Unicode chunk after JSON escaping expands the wire frame", async () => {
    const text = "🙂".repeat(8_192);
    mockTransport.fetch.mockResolvedValue(streamResponse([
      `event: markdown\ndata: {"event":"markdown","index":0,"text":"${"\\ud83d\\ude42".repeat(8_192)}"}\n\n`,
      frame("complete", { status: "complete", matched: 1, included: 1,
        failed: 0, truncated: false }),
    ]));
    const result = await streamOwnerDriveCompilation(input);
    expect(result.markdown).toBe(text);
  });

  it("uses only an allowlisted error code and drops private server text", async () => {
    mockTransport.fetch.mockResolvedValue(streamResponse([
      frame("error", { code: "reconnect_required", message: "PRIVATE_PROVIDER_DETAIL" }),
    ]));
    await expect(streamOwnerDriveCompilation(input)).rejects.toMatchObject({
      code: "reconnect_required", message: "reconnect_required",
    });
  });
});
