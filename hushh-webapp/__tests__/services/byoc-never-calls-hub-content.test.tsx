/**
 * An owner whose agent runs in their own cloud never calls a hub content route.
 *
 * Everything the app used to send the hub during chat (messages typed while a
 * reply runs, stop, ratings), the Email, Location and Information tabs, Kai,
 * voice command proposals and connector settings go to the owner's own agent.
 * These drive the real routing (pod-app-access, the specialist chat helper, the
 * private Location controller) with the hub and the agent replaced by recorders,
 * and fail if any `/api/one/(agent-chat|email|location|information|kai)` or
 * `/api/kai` request reaches the hub for such an owner.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HUB_CONTENT = /^\/api\/(?:one\/(?:agent-chat|email|location|information|kai|action-proposals)|kai)(?:[/?]|$)/;

const calls = vi.hoisted(() => ({
  hub: [] as string[],
  direct: [] as Array<{ route: string; init: RequestInit }>,
  hosting: { hostingMode: "byoc" as string },
  directReply: (route: string): unknown => ({ route }),
}));

const record = vi.hoisted(() => ({
  hubFetch: async (path: string) => {
    calls.hub.push(path);
    return new Response(JSON.stringify({}), { status: 200 });
  },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: "owner-a" }), getIdToken: async () => "id" },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({ loadPinnedEndpoint: async () => null }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: { uid: "owner-a" } }) }));
vi.mock("@/lib/services/api-client", () => ({
  apiJson: async (path: string) => {
    calls.hub.push(path);
    return {};
  },
  ApiError: class extends Error {},
  apiErrorCode: () => null,
}));
vi.mock("@/lib/services/api-service", async () => {
  const access = await vi.importActual<typeof import("@/lib/services/pod-app-access")>(
    "@/lib/services/pod-app-access",
  );
  const direct = async (route: string, init: RequestInit = {}) => {
    calls.direct.push({ route, init });
    return new Response(JSON.stringify(calls.directReply(route)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const ApiService = {
    apiFetch: record.hubFetch,
    getPersonalAgentStatus: async () => calls.hosting,
    ownerPodRequest: direct,
    agentChatRequest: (path: string, init: RequestInit) =>
      access.agentChatRequest(path, init, {
        hosting: async () => calls.hosting,
        fetch: record.hubFetch,
        direct,
      }),
  };
  return { ApiService };
});

const streamAgentChat = vi.hoisted(() =>
  vi.fn(async (input: { conversationId?: string | null }) => ({
    conversationId: input.conversationId || "agent-thread",
    model: null,
    text: "From your agent.",
    interrupted: false,
    detached: false,
  })),
);
vi.mock("@/lib/services/agent-chat-client", async () => ({
  ...(await vi.importActual<object>("@/lib/services/agent-chat-client")),
  streamAgentChat,
}));

const VAULT_KEY = "0f".repeat(32);

beforeEach(() => {
  calls.hub.length = 0;
  calls.direct.length = 0;
  calls.hosting = { hostingMode: "byoc" };
  calls.directReply = (route: string) => ({ route });
  streamAgentChat.mockClear();
  vi.stubGlobal("fetch", async (url: string) => {
    calls.hub.push(String(url));
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(calls.hub.filter((path) => HUB_CONTENT.test(path))).toEqual([]);
});

describe("an own-cloud owner's chat controls reach their agent", () => {
  it("sends queue, withdraw, status and stop to the agent", async () => {
    const { createQueuedInputPorts } = await import("@/lib/services/agent-chat-client");
    calls.directReply = (route) =>
      route.endsWith("/stop") ? { stopped: true, returned: [] } : { status: "queued", receipts: [] };
    const ports = createQueuedInputPorts(() => "vault-owner-token");
    await ports.enqueue("conv-1", "client-msg-0001", "and Tuesday too");
    await ports.withdraw("conv-1", "client-msg-0001");
    await ports.status("conv-1", ["client-msg-0001"]);
    await ports.stop("conv-1");
    expect(calls.direct.map((call) => call.route.split("?")[0])).toEqual([
      "agent-chat/runs/conv-1/queue",
      "agent-chat/runs/conv-1/queue/client-msg-0001",
      "agent-chat/runs/conv-1/queue",
      "agent-chat/runs/conv-1/stop",
    ]);
  });

  it("keeps ratings on the agent", async () => {
    const { getAgentChatFeedback, setAgentChatFeedback } = await import(
      "@/lib/services/agent-chat-client"
    );
    calls.directReply = () => ({ ratings: { "m-1": "up" } });
    expect(await getAgentChatFeedback({ conversationId: "conv-1", vaultOwnerToken: "t" })).toEqual({
      "m-1": "up",
    });
    await setAgentChatFeedback({ conversationId: "conv-1", messageId: "m-1", rating: "down", vaultOwnerToken: "t" });
    expect(calls.direct.map((call) => call.route.split("?")[0])).toEqual([
      "agent-chat/feedback",
      "agent-chat/feedback",
    ]);
  });
});

describe("the specialist tabs ask the owner's agent with a closed focus", () => {
  it.each([
    ["email", async () => (await import("@/lib/services/email-chat-service")).EmailChatService.chat],
    ["location", async () => {
      const { OneLocationService } = await import("@/lib/one-location/service");
      return OneLocationService.chat.bind(OneLocationService);
    }],
    ["information", async () => {
      const { OneMarketplaceService } = await import("@/lib/one-marketplace/service");
      return OneMarketplaceService.chat.bind(OneMarketplaceService);
    }],
  ] as const)("%s", async (focus, load) => {
    const chat = (await load()) as (params: Record<string, unknown>) => Promise<{ response: string }>;
    const reply = await chat({ vaultOwnerToken: "t", vaultKey: VAULT_KEY, message: "what is new?" });
    expect(reply.response).toBe("From your agent.");
    expect(streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ specialistFocus: focus, message: "what is new?" }),
    );
  });

  it("refuses with the placement, never the hub, while setup is still running", async () => {
    calls.hosting = { hostingMode: "pending" };
    const { EmailChatService } = await import("@/lib/services/email-chat-service");
    const refused = await EmailChatService.chat({ vaultOwnerToken: "t", vaultKey: VAULT_KEY, message: "hi" })
      .catch((error: Error & { code?: string }) => error);
    expect((refused as Error & { code?: string }).code).toBe("AGENT_PRIVATE_RUNTIME_REQUIRED:pending");
    expect(streamAgentChat).not.toHaveBeenCalled();
    const { ownerPodTurnErrorMessage } = await import("@/lib/agent/owner-pod-turn-errors");
    expect(ownerPodTurnErrorMessage("AGENT_PRIVATE_RUNTIME_REQUIRED", "AGENT_PRIVATE_RUNTIME_REQUIRED:pending"))
      .toContain("still being set up");
    expect(ownerPodTurnErrorMessage("x", "AGENT_PRIVATE_RUNTIME_REQUIRED:unplaced")).toContain("Choose where");
    expect(ownerPodTurnErrorMessage("x", "AGENT_PRIVATE_RUNTIME_REQUIRED:hussh_pods")).toContain("paused");
  });

  it("still lets a Shared owner use the hub tab", async () => {
    calls.hosting = { hostingMode: "shared" };
    const { EmailChatService } = await import("@/lib/services/email-chat-service");
    await EmailChatService.chat({ vaultOwnerToken: "t", vaultKey: VAULT_KEY, message: "hi" });
    expect(calls.hub).toEqual(["/api/one/email/chat"]);
    calls.hub.length = 0; // the afterEach guard is for private owners
  });
});

describe("Kai for an own-cloud owner", () => {
  it("shows that Kai is coming to their agent and renders no Kai surface", async () => {
    const { KaiPrivateAgentGate } = await import("@/components/kai/kai-private-agent-gate");
    render(
      <KaiPrivateAgentGate>
        <div>kai workspace</div>
      </KaiPrivateAgentGate>,
    );
    expect(await screen.findByText("Kai will be available on your agent soon.")).toBeTruthy();
    expect(screen.queryByText("kai workspace")).toBeNull();
  });
});

describe("voice commands and connector settings", () => {
  it("plans and checkpoints a typed command on the agent and runs its typed effect", async () => {
    const { PrivateLocationCommand } = await import("@/lib/agent/location-command-private");
    const checkpoint = { command_id: "0b6f6a1e-2f4c-4d1a-9a59-5f1f3c1e2d3b", revision: 1, next_step: 0 };
    calls.directReply = (route) =>
      route.endsWith("/typed")
        ? {
            plan: { steps: [{ action_id: "location.open_now", slots: {} }], gate: null },
            checkpoint,
          }
        : { checkpoint: { ...checkpoint, revision: 2, next_step: 1, status: "completed" } };
    const execute = vi.fn(async () => ({ status: "succeeded", resultSummary: "Opened." }));
    const present = vi.fn();
    const command = new PrivateLocationCommand({
      ports: {
        execute: execute as never,
        navigate: vi.fn(async () => true),
        context: () => ({ screen: "location" }),
        present,
      },
      assess: vi.fn(),
      observations: () => [],
      transcript: () => "open location",
    });
    await command.submit({ requestId: checkpoint.command_id, typedAction: { action_id: "location.open_now", slots: {} } });
    expect(calls.direct.map((call) => call.route)).toEqual([
      "agent-chat/proposals/typed",
      `agent-chat/proposals/${checkpoint.command_id}/settle`,
    ]);
    expect(execute).toHaveBeenCalledWith(
      "location.open_now",
      {},
      expect.objectContaining({ operationId: `pod:${checkpoint.command_id}:0` }),
      expect.anything(),
    );
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "result", message: "Done." }));
  });

  it("refreshes a private connector's tools on the agent", async () => {
    const { connectorSettingsRequest } = await import("@/lib/services/private-connector-transport");
    await connectorSettingsRequest("custom_" + "a".repeat(32), "mcp/catalog", { method: "POST" });
    expect(calls.direct.map((call) => call.route)).toEqual([
      `agent-chat/connectors/custom_${"a".repeat(32)}/mcp/catalog`,
    ]);
    expect(calls.hub.filter((path) => path.startsWith("/api/connectors"))).toEqual([]);
  });
});
