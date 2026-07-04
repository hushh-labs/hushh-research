import { describe, expect, it, vi } from "vitest";

import { consumeAgentChatStream } from "@/lib/services/agent-chat-client";

function sse(...frames: Array<[string, unknown]>): Response {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("agent chat specialist directives", () => {
  it("preserves consent-required prompt payloads", async () => {
    const onSpecialistDirective = vi.fn();

    await consumeAgentChatStream(
      sse(
        ["start", { conversation_id: "c1", model: "one+nav" }],
        ["token", { token: "Nav needs permission." }],
        [
          "specialist_directive",
          {
            delegate_agent_id: "agent_nav",
            directive: {
              kind: "prompt",
              payload: {
                kind: "consent_required",
                agentId: "agent_nav",
                requiredScope: "agent.nav.review",
                reason: "missing_scope",
              },
            },
            message: "Nav needs permission.",
            state_changed: false,
          },
        ],
        ["complete", { conversation_id: "c1", status: "complete", model: "one+nav" }],
      ),
      { onSpecialistDirective },
    );

    expect(onSpecialistDirective).toHaveBeenCalledWith({
      delegateAgentId: "agent_nav",
      directive: {
        kind: "prompt",
        payload: {
          kind: "consent_required",
          agentId: "agent_nav",
          requiredScope: "agent.nav.review",
          reason: "missing_scope",
        },
      },
      message: "Nav needs permission.",
      stateChanged: false,
    });
  });

  it("preserves consent action prompt payloads", async () => {
    const onSpecialistDirective = vi.fn();

    await consumeAgentChatStream(
      sse(
        ["start", { conversation_id: "c1", model: "one+nav" }],
        ["token", { token: "You have approved access." }],
        [
          "specialist_directive",
          {
            delegate_agent_id: "agent_nav",
            directive: {
              kind: "prompt",
              payload: {
                kind: "consent_actions",
                items: [
                  {
                    id: "one_location_grant:grant_1",
                    label: "Gautam Ahuja",
                    scope: "cap.location.live.view",
                    actions: ["revoke", "details"],
                  },
                ],
              },
            },
            message: "You have approved access.",
            state_changed: false,
          },
        ],
        ["complete", { conversation_id: "c1", status: "complete", model: "one+nav" }],
      ),
      { onSpecialistDirective },
    );

    expect(onSpecialistDirective).toHaveBeenCalledWith(
      expect.objectContaining({
        delegateAgentId: "agent_nav",
        directive: expect.objectContaining({
          kind: "prompt",
          payload: expect.objectContaining({
            kind: "consent_actions",
            items: expect.arrayContaining([
              expect.objectContaining({
                id: "one_location_grant:grant_1",
                actions: ["revoke", "details"],
              }),
            ]),
          }),
        }),
      }),
    );
  });
});
