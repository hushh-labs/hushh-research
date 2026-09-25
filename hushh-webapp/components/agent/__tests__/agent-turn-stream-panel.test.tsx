import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { uid: "stream-panel-reviewer", getIdToken: vi.fn(async () => "test-token") },
  getViewer: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-owner-token",
  }),
}));

vi.mock("@/lib/services/person-profile-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/person-profile-service")>();
  return {
    ...actual,
    PersonProfileService: {
      ...actual.PersonProfileService,
      getViewer: mocks.getViewer,
    },
  };
});

vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({
  OneKycClientZkService: {
    ensureConnector: vi.fn(async () => ({ connector_key_id: "test-connector" })),
  },
}));

beforeEach(() => {
  mocks.getViewer.mockResolvedValue({
    personRef: "1234567890abcdef",
    displayName: "Alex Morgan",
    photoUrl: null,
    verifiedRole: null,
    relationship: {
      status: "connected",
      connectionId: "test-connection",
      connectedAt: null,
      requestId: null,
    },
    grants: [],
    requestHistory: [],
    requestableScopes: [
      {
        scopeRef: "scope_ref_private_123",
        label: "Employment status",
        description: "Current employment eligibility status.",
        domain: "Identity",
        sensitivity: "sensitive",
        wildcard: false,
      },
      {
        scopeRef: "scope_ref_private_456",
        label: "Tax residency",
        description: null,
        domain: "Financial",
        sensitivity: "restricted",
        wildcard: false,
      },
    ],
    scopeCatalog: {
      page: 1,
      nextPage: null,
      limit: 100,
      totalCount: 2,
      hasMore: false,
      catalogRevision: "test-revision",
      paginationReset: false,
      domains: [],
    },
  });
});

import {
  AgentTurnStreamPanel,
  PRIVATE_MEMORY_PREPARATION_EVENT_ID,
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
  it("renders metadata provenance and opens Connectors only on explicit click", () => {
    const onOpenConnections = vi.fn();
    const experience = { type: "one.connector_read.v1" as const, connector: "mail" as const,
      status: "ok" as const, sourceRefs: ["mail:1"], metadataOnly: true as const, truncated: true };
    const { rerender } = render(<AgentTurnStreamPanel streamEvents={[]} responseText="Your answer."
      isStreaming={false} structuredExperience={experience} onOpenConnections={onOpenConnections} />);
    expect(screen.getByRole("region", { name: "Mail read details" })).toBeInTheDocument();
    expect(screen.getByText("Metadata only · 1 cited source")).toBeInTheDocument();
    expect(screen.getByText("Mail 1")).toBeInTheDocument();
    expect(screen.getByText("Some matches or metadata were omitted.")).toBeInTheDocument();
    expect(onOpenConnections).not.toHaveBeenCalled();
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="Reconnect your Mail."
      isStreaming={false} structuredExperience={{ ...experience, status: "reconnect_required", sourceRefs: [] }}
      onOpenConnections={onOpenConnections} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Connectors" }));
    expect(onOpenConnections).toHaveBeenCalledOnce();
    expect(screen.queryByText("Mail 1")).not.toBeInTheDocument();
  });
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

  it("uses the originating call for a parked directive so one tool stays one activity", () => {
    const event = agentToolEventToVisibleStreamEvent(
      "waiting",
      makeToolEvent({ callId: "call-42:directive", directiveId: "call-42" }),
      1_700_000,
    );

    expect(event.id).toBe("call-42");
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

  it("shows private-memory preparation without a second generic pending line", () => {
    const preparation = {
      id: PRIVATE_MEMORY_PREPARATION_EVENT_ID,
      label: "Private memory",
      message: "Preparing your private memory.",
      status: "running" as const,
      createdAtMs: 1_700_001,
    };
    const { rerender } = render(
      <AgentTurnStreamPanel streamEvents={[preparation]} responseText="" isStreaming />,
    );

    expect(screen.getByText("Preparing your private memory.")).toBeInTheDocument();
    expect(screen.queryByText("One is preparing your response.")).not.toBeInTheDocument();

    rerender(
      <AgentTurnStreamPanel
        streamEvents={[{ ...preparation, message: "Private memory ready.", status: "done" }]}
        responseText=""
        isStreaming
      />,
    );
    expect(screen.getByText("Private memory ready.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("One is preparing your response.");
  });

  it("never renders legacy reasoning during a turn or after the answer arrives", () => {
    const legacyProps = { thinkingText: "Private provider reasoning." };
    const { rerender } = render(
      <AgentTurnStreamPanel
        {...legacyProps}
        streamEvents={[]}
        responseText=""
        isStreaming
      />
    );

    expect(screen.queryByText(legacyProps.thinkingText)).not.toBeInTheDocument();
    expect(screen.queryByRole("log", { name: "Thinking details" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("One is preparing your response.");
    expect(screen.queryByText("Waiting for response tokens.")).not.toBeInTheDocument();

    rerender(
      <AgentTurnStreamPanel
        {...legacyProps}
        streamEvents={[]}
        responseText="The settings are ready."
        isStreaming
      />,
    );
    expect(screen.queryByRole("button", { name: /One is thinking/i })).not.toBeInTheDocument();
    expect(screen.queryByText(legacyProps.thinkingText)).not.toBeInTheDocument();
    expect(screen.getByText("The settings are ready.")).toBeInTheDocument();
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

  it("renders validated AG-UI scope discovery as a Morphy information surface", async () => {
    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="You can review these fields before asking for access."
        isStreaming={false}
        structuredExperience={{
          type: "one.scope_discovery.v1",
          person: {
            personRef: "1234567890abcdef",
            displayName: "Alex Morgan",
            profilePath: "/people/1234567890abcdef",
            relationship: "connected",
          },
          domainFilter: "Financial",
          scopes: [
            {
              scopeRef: "scope_ref_private_123",
              label: "Employment status",
              description: "Current employment eligibility status.",
              domain: "Identity",
              sensitivity: "sensitive",
            },
            {
              scopeRef: "scope_ref_private_456",
              label: "Tax residency",
              description: null,
              domain: "Financial",
              sensitivity: "restricted",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Information available from Alex Morgan" }),
    ).toHaveAttribute("data-experience-type", "one.scope_discovery.v1");
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalled());
    await act(async () => {
      screen.getByRole("button", { name: "Open Identity" }).click();
    });
    expect(await screen.findByRole("button", { name: "Employment status" })).toBeInTheDocument();
    await act(async () => {
      screen.getByTestId("scope-discovery-scopes-back").click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Open Financial" }).click();
    });
    expect(await screen.findByRole("button", { name: "Tax residency" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Tax residency" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View profile" })).toHaveAttribute(
      "href",
      "/people/1234567890abcdef",
    );
    expect(screen.queryByText("scope_ref_private_123")).not.toBeInTheDocument();
    expect(
      screen.queryByText("You can review these fields before asking for access."),
    ).toBeInTheDocument();
  });

  it("shows safe discovery descriptors while current authority is refreshing", async () => {
    mocks.getViewer.mockReturnValue(new Promise(() => undefined));

    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="I found information you can review."
        isStreaming={false}
        structuredExperience={{
          type: "one.scope_discovery.v1",
          person: {
            personRef: "1234567890abcdef",
            displayName: "Alex Morgan",
            profilePath: "/people/1234567890abcdef",
            relationship: "connected",
          },
          domainFilter: "Professional",
          scopes: [
            {
              scopeRef: "scope_ref_private_789",
              label: "Employment status",
              description: "Current employment eligibility status.",
              domain: "Professional",
              sensitivity: "standard",
            },
          ],
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Professional" }));
    expect(screen.getByText("Employment status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review request/ })).toBeDisabled();
    expect(screen.getByText("Checking what is currently available to request.")).toBeInTheDocument();
  });

  it("keeps supplementary notes alongside multiple distinct cards", () => {
    render(
      <AgentTurnStreamPanel
        streamEvents={[]}
        responseText="A short clarification."
        isStreaming={false}
        structuredExperiences={[
          {
            id: "activity-1",
            experience: {
              type: "one.scope_discovery.v1",
              person: {
                displayName: "Alex Morgan",
                profilePath: "/people/1234567890abcdef",
                relationship: "connected",
              },
              domainFilter: null,
              scopes: [],
              presentation: "primary_card",
            },
          },
          {
            id: "activity-2",
            experience: {
              type: "one.scope_discovery.v1",
              person: {
                displayName: "Alex Morgan",
                profilePath: "/people/1234567890abcdef",
                relationship: "connected",
              },
              domainFilter: "Professional",
              scopes: [],
              presentation: "supplementary_note",
            },
          },
        ]}
      />,
    );

    expect(screen.getAllByRole("region", { name: "Information available from Alex Morgan" })).toHaveLength(2);
    expect(screen.getByText("A short clarification.")).toBeInTheDocument();
  });
});
