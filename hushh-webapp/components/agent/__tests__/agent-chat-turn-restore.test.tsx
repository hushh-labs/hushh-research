import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ pathname: "/", push: vi.fn(), replace: vi.fn(), toast: vi.fn() }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => shell.pathname,
  useRouter: () => ({ push: shell.push, replace: shell.replace }),
}));
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(shell.toast, actual.toast) };
});
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner-1" } }) }));
vi.mock("@/lib/vault/vault-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/vault-context")>()),
  // Locked: the notice must still work and must reveal nothing.
  useVault: () => ({ vaultKey: null, getVaultOwnerToken: () => null }),
}));

import {
  chatHeaderSubtitle,
  labelRestoredConnectorSteps,
  restoredMessageTime,
  storedMessagesToAgentMessages,
} from "@/components/agent/agent-chat-workspace";
import { parseAgentActivityExperience } from "@/lib/agent/agui-structured-experiences";
import { parseRestoredTurnActivity, type AgentChatMessage } from "@/lib/services/agent-chat-client";
import { AgentChatTurnNotifier } from "@/components/agent/agent-chat-turn-notifier";
import {
  decideAgentTurnNotice,
  settleWatchedAgentTurn,
  watchDetachedAgentTurn,
} from "@/lib/agent/agent-chat-turn-watch";
import { rememberInAppChat } from "@/lib/agent/in-app-chat-selection";

// Leaving a chat and coming back must restore the same turn the owner saw:
// the Activity rows and the connect card, not only the answer text. The
// history descriptor carries enums and ids only; labels come from the app.
const connectAnswer: AgentChatMessage = {
  id: "answer-event",
  conversation_id: "thread",
  role: "assistant",
  status: "complete",
  content: "We are not connected to Google Calendar yet. Use the Connect card above.",
  created_at: null,
  completed_at: null,
  metadata: {
    kind: "structured_experience",
    structuredExperiences: [{
      id: "tool-event:call-calendar",
      activityType: "one.workspace_connector_setup.v1",
      content: { provider: "calendar", status: "connect_required" },
    }],
    turnActivity: {
      activityType: "one.turn_activity.v1",
      content: {
        steps: [
          { id: "call-calendar", tool: "discover_workspace_tools", status: "done", provider: "calendar" },
          { id: "call-mcp", tool: `mcp_${"a".repeat(40)}`, status: "done", review: "read_only", connectorId: "custom_0123" },
          { id: "call-review", tool: `mcp_${"b".repeat(40)}`, status: "waiting", review: "required" },
          { id: "call-public", tool: `mcp_${"c".repeat(40)}`, status: "done", review: "no_credential" },
        ],
      },
    },
  },
};

describe("restoring a turn from history", () => {
  it("rehydrates the Activity rows and the connect card with the answer", () => {
    const [restored] = storedMessagesToAgentMessages([connectAnswer]);
    expect(restored?.text).toContain("Connect card above");
    expect(restored?.structuredExperiences?.map((entry) => entry.experience)).toEqual([
      { type: "one.workspace_connector_setup.v1", provider: "calendar", status: "connect_required" },
    ]);
    expect(restored?.streamEvents).toEqual([
      // Routine: the panel keeps it out of Activity, exactly as on the live turn.
      expect.objectContaining({ id: "call-calendar", label: "Google Calendar", message: "Connector access checked.", status: "done", brand: "calendar", routine: true }),
      expect.objectContaining({ id: "call-mcp", label: "Connected tool", status: "done", tag: "Read", connectorId: "custom_0123" }),
      expect.objectContaining({ id: "call-review", status: "waiting", tag: "Needs review" }),
      expect.objectContaining({ id: "call-public", status: "done", tag: "Public" }),
    ]);
  });

  it("drops unknown tools, statuses and smuggled fields instead of rendering them", () => {
    const steps = parseRestoredTurnActivity({
      activityType: "one.turn_activity.v1",
      content: {
        steps: [
          { id: "x", tool: "transfer_to_agent", status: "done" },
          { id: "y", tool: "discover_workspace_tools", status: "exploded" },
          { id: "z", tool: "discover_workspace_tools", status: "done", provider: "https://evil.test", label: "Injected", message: "Injected text" },
          { id: "w", tool: `mcp_${"d".repeat(40)}`, status: "done", connectorId: "../../etc" },
        ],
      },
    });
    expect(steps.map((step) => step.id)).toEqual(["z", "w"]);
    expect(steps[0]).toMatchObject({ label: "Connector access", message: "Connector access checked." });
    expect(steps[0].provider).toBeUndefined();
    expect(JSON.stringify(steps)).not.toContain("Injected");
    expect(steps[1].connectorId).toBeUndefined();
    expect(parseRestoredTurnActivity({ activityType: "one.other.v1", content: { steps: [] } })).toEqual([]);
  });

  it("marks a step that never returned as unfinished, never as a success", () => {
    const [step] = parseRestoredTurnActivity({
      activityType: "one.turn_activity.v1",
      content: { steps: [{ id: "cut", tool: "read_workspace_tool", status: "interrupted" }] },
    });
    expect(step).toMatchObject({ status: "blocked", message: "This step did not finish." });
  });

  it("parses only a provider enum and status for a restored connect card", () => {
    expect(parseAgentActivityExperience("one.workspace_connector_setup.v1", {
      provider: "calendar", status: "connect_required", grant: "secret", account: "owner@example.test",
    })).toEqual({ type: "one.workspace_connector_setup.v1", provider: "calendar", status: "connect_required" });
    expect(parseAgentActivityExperience("one.workspace_connector_setup.v1", { provider: "outlook", status: "connect_required" })).toBeNull();
    expect(parseAgentActivityExperience("one.workspace_connector_setup.v1", { provider: "drive", status: "granted" })).toBeNull();
    expect(parseAgentActivityExperience("one.workspace_connector_setup.v1", {
      provider: "custom", status: "manage_available",
      saved: [{ id: `custom_${"e".repeat(32)}`, name: "Synthetic app", status: "saved" }],
    })).toEqual({
      type: "one.workspace_connector_setup.v1", provider: "custom", status: "manage_available",
      saved: [{ id: `custom_${"e".repeat(32)}`, name: "Synthetic app", status: "saved" }],
    });
  });
});

describe("the chat header during a turn", () => {
  it("names the running call, newest first, then returns to the idle subtitle", () => {
    const gmail = { id: "a", label: "Gmail", activity: "Checking Gmail" };
    const drive = { id: "b", label: "Google Drive", activity: "Searching Drive" };
    const header = (activeToolCalls: typeof gmail[], statusText: string | null = "Thinking") =>
      chatHeaderSubtitle({ isPuppySurface: false, activeToolCalls, statusText });
    expect(header([gmail])).toBe("Checking Gmail…");
    expect(header([gmail, drive])).toBe("Searching Drive…");
    expect(header([])).toBe("Thinking");
    expect(header([], null)).toBe("Your private agent");
    // Puppy One's header never narrates One's calls.
    expect(chatHeaderSubtitle({ isPuppySurface: true, activeToolCalls: [gmail], statusText: null }))
      .toBe("Separate conversation");
  });
});

describe("restored turn details", () => {
  it("restores a roster step with the live label and mark, and the answer's markdown verbatim", () => {
    const answer = "Here is **tomorrow**:\n\n1. [Standup](https://example.test)\n2. Run `sync`";
    const [restored] = storedMessagesToAgentMessages([{
      ...connectAnswer,
      content: answer,
      metadata: { turnActivity: { activityType: "one.turn_activity.v1", content: {
        steps: [{ id: "call-events", tool: "calendar_events", status: "done" }],
      } } },
    }]);
    expect(restored?.text).toBe(answer);
    expect(restored?.streamEvents).toEqual([expect.objectContaining({
      label: "Google Calendar", message: "Reading your calendar events.", status: "done", brand: "calendar",
    })]);
  });


  it("reads epoch-second history timestamps as seconds, not 1970 milliseconds", () => {
    const seconds = 1_790_000_000.25;
    expect(restoredMessageTime(seconds)?.getTime()).toBe(seconds * 1000);
    expect(restoredMessageTime(String(seconds))?.getTime()).toBe(seconds * 1000);
    expect(restoredMessageTime("2026-09-26T07:46:00Z")?.toISOString()).toBe("2026-09-26T07:46:00.000Z");
    expect(restoredMessageTime(1_790_000_000_250)?.getTime()).toBe(1_790_000_000_250);
    expect(restoredMessageTime(null)).toBeNull();
    expect(restoredMessageTime("not a time")).toBeNull();
  });

  it("labels restored connector rows with the owner's vault name only", () => {
    const [restored] = storedMessagesToAgentMessages([connectAnswer]);
    const labeled = labelRestoredConnectorSteps([restored!], new Map([["custom_0123", "Hussh Wiki"]]));
    expect(labeled[0].streamEvents?.find((event) => event.id === "call-mcp")?.label).toBe("Hussh Wiki");
    expect(labeled[0].streamEvents?.find((event) => event.id === "call-review")?.label).toBe("Connected tool");
    const unchanged = [restored!];
    expect(labelRestoredConnectorSteps(unchanged, new Map())).toBe(unchanged);
  });
});

// Leaving a chat mid-answer: the turn keeps running server-side, and when it
// settles the app says so only if the person is not already looking at it.
describe("a turn that settles after the person left the chat", () => {
  const conversationId = "0b1f6c1e-3d4a-4c8b-9a51-6f2e7d8c9b0a";
  const settle = () => act(() => {
    watchDetachedAgentTurn({ ownerId: "owner-1", conversationId, startedAtMs: Date.now() });
    settleWatchedAgentTurn("owner-1", conversationId, true);
  });

  beforeEach(() => {
    shell.toast.mockClear();
    shell.pathname = "/";
    rememberInAppChat("owner-1", conversationId);
  });

  it("stays quiet while that chat is on screen", () => {
    render(<AgentChatTurnNotifier />);
    settle();
    expect(shell.toast).not.toHaveBeenCalled();
  });

  it("says One replied with an Open action, and no answer text, from elsewhere", () => {
    shell.pathname = "/one/feed";
    render(<AgentChatTurnNotifier />);
    settle();
    expect(shell.toast).toHaveBeenCalledTimes(1);
    const [title, options] = shell.toast.mock.calls[0];
    expect(title).toBe("One replied");
    expect(options).toMatchObject({ description: "Your answer is ready.", action: { label: "Open" } });
    // The notice is built from fixed copy and an id only; nothing from the turn.
    expect(Object.keys(options).sort()).toEqual(["action", "description", "id"]);
  });

  it("leaves the notice to the push when the native app was in the background", () => {
    expect(decideAgentTurnNotice({ viewingConversation: false, pageVisible: true, pushOwnsNotice: true })).toBe("none");
    expect(decideAgentTurnNotice({ viewingConversation: false, pageVisible: false, pushOwnsNotice: false })).toBe("defer");
    expect(decideAgentTurnNotice({ viewingConversation: true, pageVisible: true, pushOwnsNotice: false })).toBe("none");
  });
});
