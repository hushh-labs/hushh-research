import { describe, expect, it, vi } from "vitest";
import { consumeAgentChatStream } from "@/lib/services/agent-chat-client";

function sse(...frames: Array<[string, unknown]>): Response {
  const body = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("specialist_directive", () => {
  it("routes the frame to onSpecialistDirective", async () => {
    const onSpecialistDirective = vi.fn();
    await consumeAgentChatStream(
      sse(
        ["start", { conversation_id: "c1", model: "one+location" }],
        ["token", { token: "Ready to share with Mom." }],
        [
          "specialist_directive",
          {
            delegate_agent_id: "agent_location",
            directive: { kind: "action", payload: { id: "act-1", type: "publish_share" } },
            message: "Ready to share with Mom.",
            state_changed: false,
          },
        ],
        ["complete", { conversation_id: "c1", status: "complete", model: "one+location" }],
      ),
      { onSpecialistDirective },
    );
    expect(onSpecialistDirective).toHaveBeenCalledWith(
      expect.objectContaining({
        delegateAgentId: "agent_location",
        directive: expect.objectContaining({ kind: "action" }),
      }),
    );
  });
});
