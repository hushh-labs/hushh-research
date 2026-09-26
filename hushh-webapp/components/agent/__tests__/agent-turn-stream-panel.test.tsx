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
  driveBatchProgressToVisibleStreamEvent,
} from "@/components/agent/agent-turn-stream-panel";
import { driveOwnerCompileKey } from "@/lib/agent/connector-read-receipt";
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
    const event = {
      ...agentToolEventToVisibleStreamEvent("result", makeToolEvent(), 1_700_000),
      durationMs: 1300,
    };

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
    expect(screen.getByText("1.3s").getAttribute("data-operation-timing")).toBe("done");
    expect(screen.queryByText("route.private.internal")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing response")).not.toBeInTheDocument();
  });

  it("shows time to first text and total response time without request content in timing tags", async () => {
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const { rerender } = render(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming />);
    now = 1800;
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="A private answer" isStreaming />);
    now = 3000;
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="A private answer" isStreaming={false} />);
    expect(await screen.findByText("Response complete in 2.0s · first text in 0.8s")).toBeInTheDocument();
    expect(screen.queryByText(/A private answer.*time/)).not.toBeInTheDocument();
    now = 5000;
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming />);
    expect(screen.queryByText("Response complete in 2.0s · first text in 0.8s")).not.toBeInTheDocument();
    now = 5400;
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="Another answer" isStreaming />);
    now = 6000;
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="Another answer" isStreaming={false} />);
    expect(await screen.findByText("Response complete in 1.0s · first text in 0.4s")).toBeInTheDocument();
    clock.mockRestore();
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

  it("shows only reported Drive file counts and advances the meter from actual checks", () => {
    const first = driveBatchProgressToVisibleStreamEvent(
      { phase: "fetching", completed: 1, total: 30, failed: 0 }, "activity-1", 1_700_001,
    );
    const { rerender } = render(
      <AgentTurnStreamPanel streamEvents={[first]} responseText="" isStreaming />,
    );

    expect(screen.getByText("Checked 1 of 30 files.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(100 / 30));
    expect(screen.queryByText("One is preparing your response.")).not.toBeInTheDocument();

    const second = driveBatchProgressToVisibleStreamEvent(
      { phase: "fetching", completed: 2, total: 30, failed: 1 }, "activity-1", 1_700_002,
    );
    expect(second.id).toBe(first.id);
    rerender(<AgentTurnStreamPanel streamEvents={[second]} responseText="" isStreaming />);
    expect(screen.getByText("Checked 2 of 30 files. 1 file could not be read or processed.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(200 / 30));
    expect(screen.queryByText("Checked 1 of 30 files.")).not.toBeInTheDocument();
  });

  it("does not show a made-up percentage before the server knows the batch size", () => {
    const searching = driveBatchProgressToVisibleStreamEvent(
      { phase: "searching", completed: 0, total: 0, failed: 0 }, "activity-1", 1_700_001,
    );
    const { rerender } = render(
      <AgentTurnStreamPanel streamEvents={[searching]} responseText="" isStreaming />,
    );
    expect(screen.getByText("Finding matching Drive files.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    const finished = driveBatchProgressToVisibleStreamEvent(
      { phase: "partial", completed: 29, total: 30, failed: 1 }, "activity-1", 1_700_002,
    );
    rerender(<AgentTurnStreamPanel streamEvents={[finished]} responseText="The available notes are below." isStreaming={false} />);
    expect(screen.getByText(/Document batch finished with some files unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("keeps real progress visible when owner compilation runs after the chat turn", () => {
    const searching = driveBatchProgressToVisibleStreamEvent(
      { phase: "searching", completed: 0, total: 0, failed: 0 }, "owner-compile", 1_700_001,
    );
    const { container, rerender } = render(
      <AgentTurnStreamPanel streamEvents={[searching]} responseText="Drive matches found."
        isStreaming={false} driveCompilation={{ status: "running" }} />,
    );
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    const fetching = driveBatchProgressToVisibleStreamEvent(
      { phase: "fetching", completed: 0, total: 0, failed: 0 }, "owner-compile", 1_700_002,
    );
    rerender(<AgentTurnStreamPanel streamEvents={[fetching]} responseText="Drive matches found."
      isStreaming={false} driveCompilation={{ status: "running" }} />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();

    const checked = driveBatchProgressToVisibleStreamEvent(
      { phase: "fetching", completed: 1, total: 30, failed: 0 }, "owner-compile", 1_700_003,
    );
    rerender(<AgentTurnStreamPanel streamEvents={[checked]} responseText="Drive matches found."
      isStreaming={false} driveCompilation={{ status: "running" }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(100 / 30));
  });

  it("offers compilation only for an owner-authorized metadata receipt", () => {
    const onCompileDriveNotes = vi.fn();
    const onDownloadDriveNotes = vi.fn();
    const experience = {
      type: "one.connector_read.v1" as const, connector: "drive" as const,
      status: "ok" as const, sourceRefs: [], metadataOnly: true, truncated: false,
      ownerCompileAvailable: true, ownerCompileQuery: "share all last 30 days standup notes",
      ownerCompileWindow: { start_date: "2026-08-27", end_date: "2026-09-25",
        timezone: "Asia/Kolkata" },
    };
    const { rerender } = render(<AgentTurnStreamPanel streamEvents={[]} responseText=""
      isStreaming={false} structuredExperience={experience}
      onCompileDriveNotes={onCompileDriveNotes} onDownloadDriveNotes={onDownloadDriveNotes} />);
    fireEvent.click(screen.getByRole("button", { name: "Compile original notes" }));
    expect(onCompileDriveNotes).toHaveBeenCalledWith(
      experience.ownerCompileQuery, experience.ownerCompileWindow,
    );
    expect(screen.queryByRole("list", { name: "Document sources" })).not.toBeInTheDocument();

    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming={false}
      structuredExperience={experience} onCompileDriveNotes={onCompileDriveNotes}
      onDownloadDriveNotes={onDownloadDriveNotes}
      driveCompilation={{ status: "partial", matched: 30, included: 29, failed: 1,
        sourceKey: driveOwnerCompileKey(experience.ownerCompileQuery, experience.ownerCompileWindow) }} />);
    expect(screen.getByText(/Compiled 29 of 30 matching files/)).toBeInTheDocument();
    expect(screen.getByText(/Some notes were unavailable or omitted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download Markdown notes" }));
    expect(onDownloadDriveNotes).toHaveBeenCalledOnce();

    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming={false}
      structuredExperience={{ ...experience, ownerCompileAvailable: false }}
      onCompileDriveNotes={onCompileDriveNotes} />);
    expect(screen.queryByRole("button", { name: "Compile original notes" })).not.toBeInTheDocument();

    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming={false}
      structuredExperience={{ ...experience, ownerCompileWindow: undefined }}
      onCompileDriveNotes={onCompileDriveNotes} />);
    expect(screen.queryByRole("button", { name: "Compile original notes" })).not.toBeInTheDocument();
  });

  it("sends each listing button's own validated query and window", () => {
    const onCompileDriveNotes = vi.fn();
    const first = {
      type: "one.connector_read.v1" as const, connector: "drive" as const,
      status: "ok" as const, sourceRefs: [], metadataOnly: true, truncated: false,
      ownerCompileAvailable: true, ownerCompileQuery: "all last 30 days standup notes",
      ownerCompileWindow: { start_date: "2026-08-27", end_date: "2026-09-25",
        timezone: "Asia/Kolkata" },
    };
    const second = {
      ...first, ownerCompileQuery: "all last 7 days planning notes",
      ownerCompileWindow: { start_date: "2026-09-19", end_date: "2026-09-25",
        timezone: "Asia/Kolkata" },
    };
    const { rerender } = render(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming={false}
      structuredExperiences={[{ id: "first", experience: first }, { id: "second", experience: second }]}
      onCompileDriveNotes={onCompileDriveNotes} />);
    const buttons = screen.getAllByRole("button", { name: "Compile original notes" });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onCompileDriveNotes.mock.calls).toEqual([
      [first.ownerCompileQuery, first.ownerCompileWindow],
      [second.ownerCompileQuery, second.ownerCompileWindow],
    ]);
    rerender(<AgentTurnStreamPanel streamEvents={[]} responseText="" isStreaming={false}
      structuredExperiences={[{ id: "first", experience: first }, { id: "second", experience: second }]}
      onCompileDriveNotes={onCompileDriveNotes} onDownloadDriveNotes={vi.fn()}
      driveCompilation={{ status: "ready", matched: 30, included: 30, failed: 0,
        sourceKey: driveOwnerCompileKey(first.ownerCompileQuery, first.ownerCompileWindow) }} />);
    expect(screen.getAllByRole("button", { name: "Download Markdown notes" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Compile original notes" })).toHaveLength(1);
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
