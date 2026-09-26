import { parseDriveBatchProgressActivity, type DriveBatchProgress } from "@/lib/agent/drive-batch-progress";
import { parseDriveOwnerCompileWindow, type DriveOwnerCompileWindow } from "@/lib/agent/connector-read-receipt";
import { ApiService } from "@/lib/services/api-service";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

const COMPILE_PATH = "/api/connectors/google_drive/sharing/owner/compile/stream";
const MAX_REQUEST_BYTES = 2_048;
const MAX_MARKDOWN_BYTES = 2_000_000;
// An 8192-codepoint chunk can expand to 12 ASCII chars/codepoint when JSON
// escapes emoji; the owner plaintext cap below remains 2 MB after decoding.
const MAX_MARKDOWN_CHUNK_CODEPOINTS = 8_192;
const MAX_WIRE_BYTES = 16_000_000;
const MAX_FRAME_CHARS = 131_072;

export type DriveCompilationStage = "starting" | "searching" | "fetching" | "finalizing";
export type DriveCompilationResult = {
  markdown: string;
  status: "complete" | "partial";
  matched: number;
  included: number;
  failed: number;
  truncated: boolean;
};

export class DriveCompilationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DriveCompilationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value : null;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,80}$/.test(value)
    ? value : "request_failed";
}

/** Never exposes source text until a complete, ordered owner stream finishes. */
export async function streamOwnerDriveCompilation(input: {
  token: string;
  message: string;
  window: DriveOwnerCompileWindow;
  signal?: AbortSignal;
  guard: () => void;
  onStage?: (stage: DriveCompilationStage) => void;
  onFile?: (progress: DriveBatchProgress) => void;
}): Promise<DriveCompilationResult> {
  const request = input.message.trim();
  const window = parseDriveOwnerCompileWindow(input.window);
  if (!request || new TextEncoder().encode(request).byteLength > MAX_REQUEST_BYTES || !window) {
    throw new DriveCompilationError("invalid_argument");
  }
  input.guard();
  const response = await nativeStreamFetch(COMPILE_PATH, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...ApiService.getAuthHeaders(input.token),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message: request, window }),
    signal: input.signal,
  });
  input.guard();
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = record(record(body)?.detail);
    throw new DriveCompilationError(safeCode(detail?.code));
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new DriveCompilationError("stream_unavailable");
  }

  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let nextIndex = 0;
  let markdownBytes = 0;
  let wireBytes = 0;
  let remainder = "";
  let lastStage = -1;
  let lastFileCompleted = 0;
  let lastFileFailed = 0;
  let fileTotal: number | null = null;
  const stages: DriveCompilationStage[] = ["starting", "searching", "fetching", "finalizing"];

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new DriveCompilationError("interrupted");
      }
      input.guard();
      if (chunk.done) throw new DriveCompilationError("interrupted");
      wireBytes += chunk.value.byteLength;
      if (wireBytes > MAX_WIRE_BYTES) throw new DriveCompilationError("invalid_response");
      const parsed = parseSSEBlocks(decoder.decode(chunk.value, { stream: true }), remainder);
      remainder = parsed.remainder;
      if (remainder.length > MAX_FRAME_CHARS) throw new DriveCompilationError("invalid_response");
      for (const frame of parsed.events) {
        if (frame.data.length > MAX_FRAME_CHARS) throw new DriveCompilationError("invalid_response");
        let payload: Record<string, unknown> | null = null;
        try {
          payload = record(JSON.parse(frame.data));
        } catch {
          throw new DriveCompilationError("invalid_response");
        }
        if (!payload) throw new DriveCompilationError("invalid_response");
        if (payload.event !== frame.event) throw new DriveCompilationError("invalid_response");
        if (frame.event === "stage") {
          const index = stages.indexOf(payload.phase as DriveCompilationStage);
          if (index < 0) throw new DriveCompilationError("invalid_response");
          if (index > lastStage) {
            lastStage = index;
            input.onStage?.(stages[index]!);
          }
        } else if (frame.event === "file") {
          const progress = parseDriveBatchProgressActivity(
            "one.drive_batch_progress.v1", payload,
          );
          if (!progress || progress.phase !== "fetching") {
            throw new DriveCompilationError("invalid_response");
          }
          if (progress.completed < lastFileCompleted || progress.failed < lastFileFailed ||
            (fileTotal !== null && progress.total !== fileTotal)) {
            throw new DriveCompilationError("invalid_response");
          }
          lastFileCompleted = progress.completed;
          lastFileFailed = progress.failed;
          fileTotal = progress.total;
          input.onFile?.(progress);
        } else if (frame.event === "markdown") {
          if (payload.index !== nextIndex || typeof payload.text !== "string" ||
            Array.from(payload.text).length > MAX_MARKDOWN_CHUNK_CODEPOINTS) {
            throw new DriveCompilationError("invalid_response");
          }
          markdownBytes += encoder.encode(payload.text).byteLength;
          if (markdownBytes > MAX_MARKDOWN_BYTES) throw new DriveCompilationError("invalid_response");
          chunks.push(payload.text);
          nextIndex += 1;
        } else if (frame.event === "complete") {
          const matched = count(payload.matched);
          const included = count(payload.included);
          const failed = count(payload.failed);
          if ((payload.status !== "complete" && payload.status !== "partial") ||
            matched === null || included === null || failed === null ||
            included > matched || failed > matched || typeof payload.truncated !== "boolean" ||
            markdownBytes === 0) {
            throw new DriveCompilationError("invalid_response");
          }
          return {
            markdown: chunks.join(""),
            status: payload.status,
            matched, included, failed, truncated: payload.truncated,
          };
        } else if (frame.event === "error") {
          throw new DriveCompilationError(safeCode(payload.code));
        }
        // Heartbeats and unknown events carry no authority to finish a batch.
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    cancel();
  }
}
