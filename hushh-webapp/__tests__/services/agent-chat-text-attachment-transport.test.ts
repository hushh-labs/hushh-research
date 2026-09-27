import { describe, expect, it, vi } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(public config: Record<string, unknown>) {}
    abortRun() {}
    async runAgent(parameters: unknown, subscriber: Record<string, (input: unknown) => void>) {
      runAgent(parameters, this.config);
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      subscriber.onTextMessageContentEvent?.({
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Done" },
      });
      subscriber.onRunFinishedEvent?.({ event: { type: "RUN_FINISHED" }, outcome: "success" });
    }
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
    apiFetchStream: vi.fn(),
    getAgentChatHistory: vi.fn(),
  },
}));

import { createAgentTextAttachment } from "@/lib/agent/large-text-attachment";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { getAgentChatHistory, streamAgentChat } from "@/lib/services/agent-chat-client";
import { ApiService } from "@/lib/services/api-service";

const TEST_VAULT_KEY = "0f".repeat(32);
const PASTE = Array.from({ length: 40 }, (_, index) => `row ${index}: naïve café ✓`).join("\n");

type SentPart = {
  type: string;
  text?: string;
  source?: { type: string; value: string; mimeType: string };
  metadata?: Record<string, unknown>;
};

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function sentUserContent(message: string, attachments = [createAgentTextAttachment(PASTE)]) {
  publishValidatedAuthSessionOwner("user-1");
  runAgent.mockClear();
  await streamAgentChat({
    vaultKey: TEST_VAULT_KEY,
    userId: "user-1",
    vaultOwnerToken: "owner-token",
    message,
    attachments,
  });
  const config = runAgent.mock.calls[0][1] as {
    initialMessages: Array<{ role: string; content: string | SentPart[] }>;
  };
  expect(config.initialMessages).toHaveLength(1);
  expect(config.initialMessages[0].role).toBe("user");
  return config.initialMessages[0].content;
}

describe("pasted text travels as an attachment part, not as message text", () => {
  it("sends the typed text and the paste as separate AG-UI content parts", async () => {
    const content = await sentUserContent("Summarize this");

    expect(Array.isArray(content)).toBe(true);
    const parts = content as SentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Summarize this" });
    expect(parts[1].type).toBe("document");
    expect(parts[1].source?.type).toBe("data");
    expect(parts[1].source?.mimeType).toBe("text/plain");
    expect(parts[1].metadata).toMatchObject({ filename: "Pasted text" });
    expect(decodeBase64Utf8(parts[1].source!.value)).toBe(PASTE);
    // The paste is never folded back into the text the person typed.
    expect(parts[0].text).not.toContain("row 0");
  });

  it("sends an attachment-only turn with no empty text part", async () => {
    const parts = (await sentUserContent("")) as SentPart[];

    expect(parts.map((part) => part.type)).toEqual(["document"]);
  });

  it("keeps an ordinary typed turn as plain string content", async () => {
    expect(await sentUserContent("Hello", [])).toBe("Hello");
  });
});

describe("history keeps a pasted attachment as a chip", () => {
  it("restores user attachments with sizes recomputed from the text, and ignores them elsewhere", async () => {
    vi.mocked(ApiService.getAgentChatHistory).mockResolvedValueOnce(new Response(JSON.stringify({
      messages: [
        {
          id: "u1", role: "user", content: "Summarize this",
          metadata: { attachments: [
            { name: "Pasted text", mimeType: "text/plain", text: PASTE, byteSize: 1, lineCount: 1 },
            { name: "Not text", mimeType: "image/png", text: "x" },
            { name: "Broken" },
          ] },
        },
        {
          id: "a1", role: "assistant", content: "Summary",
          metadata: { attachments: [{ name: "Pasted text", mimeType: "text/plain", text: "PRIVATE" }] },
        },
      ],
    })));

    const [user, assistant] = await getAgentChatHistory({
      vaultKey: TEST_VAULT_KEY, conversationId: "c1", vaultOwnerToken: "owner-token",
    });

    expect(user.content).toBe("Summarize this");
    expect(user.metadata?.attachments).toEqual([createAgentTextAttachment(PASTE)]);
    expect(user.metadata?.attachments?.[0]).toMatchObject({ lineCount: 40, mimeType: "text/plain" });
    expect(assistant.metadata?.attachments).toBeUndefined();
  });
});
