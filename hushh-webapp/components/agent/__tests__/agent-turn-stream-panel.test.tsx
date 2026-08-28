import { fireEvent, render, screen } from "@testing-library/react";
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

    expect(screen.getByText("Activity")).toBeInTheDocument();
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
    expect(screen.getByRole("region", { name: "One activity" })).toHaveClass("w-full", "max-w-none");
  });

  it("shows an app-owned pending state while progress is available but response text has not arrived", () => {
    const event = agentToolEventToVisibleStreamEvent("start", makeToolEvent(), 1_700_001);

    render(
      <AgentTurnStreamPanel
        streamEvents={[event]}
        responseText=""
        isStreaming
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("One is preparing your response.");
    expect(screen.queryByText("Waiting for response tokens.")).not.toBeInTheDocument();
  });

  it("does not expose provider reasoning to the consumer", () => {
    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText=""
        thinkingText="**Checking context**\n\nComparing the active settings."
        isStreaming
      />
    );

    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking context")).not.toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes("Comparing the active settings."))).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("One is preparing your response.");
    expect(screen.queryByText("Waiting for response tokens.")).not.toBeInTheDocument();
  });

  it("presents consulted specialists as bounded provenance without internal ids or request text", async () => {
    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="The Finance specialist reviewed this."
        isStreaming={false}
        sources={[
          {
            agentId: "agent_kai",
            label: "Finance",
            reason: "Review the portfolio question.",
          },
          {
            agentId: "agent_kai",
            label: "Finance",
            reason: "Duplicate source.",
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: /Activity 1/i })).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Finance specialist consulted.")).toBeInTheDocument();
    expect(screen.queryByText("agent_kai")).not.toBeInTheDocument();
    expect(screen.queryByText("Review the portfolio question.")).not.toBeInTheDocument();
    expect(screen.queryByText("Duplicate source.")).not.toBeInTheDocument();
  });
});
