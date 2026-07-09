import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentTurnStreamPanel,
  agentToolEventToVisibleStreamEvent,
} from "@/components/agent/agent-turn-stream-panel";
import type { AgentChatToolEvent } from "@/lib/services/agent-chat-client";

function makeToolEvent(overrides: Partial<AgentChatToolEvent> = {}): AgentChatToolEvent {
  return {
    callId: "tool-call-1",
    actionId: "route.private.internal",
    label: "Open workspace",
    execution: "frontend",
    slots: { secret_path: "/internal" },
    message: "Opening the right workspace.",
    raw: { action_id: "route.private.internal", token: "hidden" },
    ...overrides,
  };
}

describe("AgentTurnStreamPanel", () => {
  it("renders tool progress without leaking raw action payloads", () => {
    const event = agentToolEventToVisibleStreamEvent("waiting", makeToolEvent(), 1_700_000);

    render(
      <AgentTurnStreamPanel
        streamEvents={[event]}
        responseText=""
        isStreaming
      />
    );

    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(screen.getByText("Open workspace")).toBeInTheDocument();
    expect(screen.getByText("Opening the right workspace.")).toBeInTheDocument();
    expect(screen.queryByText("route.private.internal")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing response")).not.toBeInTheDocument();
  });

  it("renders a streaming response with the cursor affordance", () => {
    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="Here is the answer."
        isStreaming
      />
    );

    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent response stream")).toHaveClass("w-full", "max-w-none");
  });

  it("does not simulate response tokens while only progress is available", () => {
    const event = agentToolEventToVisibleStreamEvent("start", makeToolEvent(), 1_700_001);

    render(
      <AgentTurnStreamPanel
        streamEvents={[event]}
        responseText=""
        isStreaming
      />
    );

    expect(screen.getByText("Waiting for response tokens.")).toBeInTheDocument();
    expect(screen.queryByText("Preparing response")).not.toBeInTheDocument();
  });
});
