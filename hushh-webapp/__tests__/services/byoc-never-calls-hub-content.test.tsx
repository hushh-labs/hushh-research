import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
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

const HUB_CONTENT =
  /^\/api\/(?:one\/(?:agent-chat|email|location|information|kai|action-proposals)|kai|pkm\/memory\/proposals)(?:[/?]|$)/;

const calls = vi.hoisted(() => ({
  hub: [] as string[],
  direct: [] as Array<{ route: string; init: RequestInit }>,
  hosting: { hostingMode: "byoc" as string },
  directReply: (route: string): unknown => ({ route }),
  hubReply: (_path: string): unknown => ({}),
  hubStatus: 200,
}));

const record = vi.hoisted(() => ({
  hubFetch: async (path: string) => {
    calls.hub.push(path);
    return new Response(JSON.stringify(calls.hubReply(path)), {
      status: calls.hubStatus,
    });
  },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () => ({ uid: "owner-a" }),
    getIdToken: async () => "id",
  },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: async () => null,
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "owner-a" }, userId: "owner-a" }),
}));
vi.mock("@/lib/services/api-client", () => ({
  apiJson: async (path: string) => {
    calls.hub.push(path);
    return {};
  },
  ApiError: class extends Error {},
  apiErrorCode: () => null,
}));
vi.mock("@/lib/services/api-service", async () => {
  const access = await vi.importActual<
    typeof import("@/lib/services/pod-app-access")
  >("@/lib/services/pod-app-access");
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
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner-a", ownerId: "owner-a", accountGeneration: 0 });
  calls.hub.length = 0;
  calls.direct.length = 0;
  calls.hosting = { hostingMode: "byoc" };
  calls.directReply = (route: string) => ({ route });
  calls.hubReply = () => ({});
  calls.hubStatus = 200;
  streamAgentChat.mockClear();
  vi.stubGlobal("fetch", async (url: string) => {
    calls.hub.push(String(url));
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  publishValidatedAuthSessionPrincipal(null);
  vi.unstubAllGlobals();
  expect(calls.hub.filter((path) => HUB_CONTENT.test(path))).toEqual([]);
});

describe("an own-cloud owner's chat controls reach their agent", () => {
  it("sends queue, withdraw, status and stop to the agent", async () => {
    const { createQueuedInputPorts } =
      await import("@/lib/services/agent-chat-client");
    calls.directReply = (route) =>
      route.endsWith("/stop")
        ? { stopped: true, returned: [] }
        : { status: "queued", receipts: [] };
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
    const { getAgentChatFeedback, setAgentChatFeedback } =
      await import("@/lib/services/agent-chat-client");
    calls.directReply = () => ({ ratings: { "m-1": "up" } });
    expect(
      await getAgentChatFeedback({
        conversationId: "conv-1",
        vaultOwnerToken: "t",
      }),
    ).toEqual({
      "m-1": "up",
    });
    await setAgentChatFeedback({
      conversationId: "conv-1",
      messageId: "m-1",
      rating: "down",
      vaultOwnerToken: "t",
    });
    expect(calls.direct.map((call) => call.route.split("?")[0])).toEqual([
      "agent-chat/feedback",
      "agent-chat/feedback",
    ]);
  });
});

describe("the specialist tabs ask the owner's agent with a closed focus", () => {
  it.each(["pending", "unknown"])(
    "keeps a %s owner's Memory proposal off the hub",
    async (hostingMode) => {
      calls.hosting = { hostingMode };
      const { previewAgentPkmMemory } =
        await import("@/lib/agent/agent-pkm-memory");
      await expect(
        previewAgentPkmMemory({
          userId: "owner-a",
          message: "Synthetic notebook preference",
          currentDomains: [],
          vaultOwnerToken: "vault-owner-token",
        }),
      ).rejects.toThrow("Nothing was saved.");
      expect(calls.hub).toEqual([]);
      expect(calls.direct).toEqual([]);
    },
  );

  it("prepares a private owner's note on their agent with no vault-owner token couriered", async () => {
    const { previewAgentPkmMemory } =
      await import("@/lib/agent/agent-pkm-memory");
    calls.directReply = () => ({ preview_cards: [] });
    await previewAgentPkmMemory({
      userId: "owner-a",
      message: "Synthetic notebook preference",
      currentDomains: [],
      vaultOwnerToken: "vault-owner-token",
    });
    expect(calls.hub).toEqual([]);
    expect(calls.direct.map((call) => call.route)).toEqual([
      "memory/proposals",
    ]);
    expect(new Headers(calls.direct[0].init.headers).has("Authorization")).toBe(
      false,
    );
    expect(JSON.parse(calls.direct[0].init.body as string)).toMatchObject({
      user_id: "owner-a",
    });
  });

  it("uses verified sharing metadata to require review of a private preparation", async () => {
    const { previewAgentPkmMemory } =
      await import("@/lib/agent/agent-pkm-memory");
    calls.directReply = () => ({
      preview_cards: [
        {
          card_id: "synthetic-card",
          source_text: "Synthetic preference",
          target_domain: "professional",
          target_entity_scope: "notebook_preference",
          write_mode: "can_save",
        },
      ],
    });
    calls.hubReply = () => ({
      active_recipient_count: 1,
      recipient_labels: ["Synthetic recipient"],
      enters_next_export_revision: true,
      summary: "One recipient is affected.",
      affected_grant_ids: ["synthetic-grant"],
      affected_export_ids: [],
    });
    const result = await previewAgentPkmMemory({
      userId: "owner-a",
      message: "Synthetic preference",
      currentDomains: [],
      vaultOwnerToken: "vault-owner-token",
    });
    expect(calls.hub).toEqual([
      "/api/pkm/memory/mutation-impact/owner-a/professional?scope_path=notebook_preference",
    ]);
    expect(result.cards[0]).toMatchObject({
      write_mode: "confirm_first",
      requires_confirmation: true,
      sharing_impact: { active_recipient_count: 1 },
    });
    expect(result.preview_summary).toMatchObject({
      can_save_count: 0,
      confirm_first_count: 1,
    });
    calls.hubReply = () => ({ active_recipient_count: "unknown" });
    await expect(
      previewAgentPkmMemory({
        userId: "owner-a",
        message: "Synthetic preference",
        currentDomains: [],
        vaultOwnerToken: "vault-owner-token",
      }),
    ).rejects.toThrow("Current sharing could not be verified");
    calls.hubStatus = 503;
    await expect(
      previewAgentPkmMemory({
        userId: "owner-a",
        message: "Synthetic preference",
        currentDomains: [],
        vaultOwnerToken: "vault-owner-token",
      }),
    ).rejects.toThrow("Current sharing could not be verified");
  });

  it.each([
    [
      "email",
      async () =>
        (await import("@/lib/services/email-chat-service")).EmailChatService
          .chat,
    ],
    [
      "location",
      async () => {
        const { OneLocationService } =
          await import("@/lib/one-location/service");
        return OneLocationService.chat.bind(OneLocationService);
      },
    ],
    [
      "information",
      async () => {
        const { OneMarketplaceService } =
          await import("@/lib/one-marketplace/service");
        return OneMarketplaceService.chat.bind(OneMarketplaceService);
      },
    ],
  ] as const)("%s", async (focus, load) => {
    const chat = (await load()) as (
      params: Record<string, unknown>,
    ) => Promise<{ response: string }>;
    const reply = await chat({
      vaultOwnerToken: "t",
      vaultKey: VAULT_KEY,
      message: "what is new?",
    });
    expect(reply.response).toBe("From your agent.");
    expect(streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistFocus: focus,
        message: "what is new?",
      }),
    );
  });

  it("refuses with the placement, never the hub, while setup is still running", async () => {
    calls.hosting = { hostingMode: "pending" };
    const { EmailChatService } =
      await import("@/lib/services/email-chat-service");
    const refused = await EmailChatService.chat({
      vaultOwnerToken: "t",
      vaultKey: VAULT_KEY,
      message: "hi",
    }).catch((error: Error & { code?: string }) => error);
    expect((refused as Error & { code?: string }).code).toBe(
      "AGENT_PRIVATE_RUNTIME_REQUIRED:pending",
    );
    expect(streamAgentChat).not.toHaveBeenCalled();
    const { ownerPodTurnErrorMessage } =
      await import("@/lib/agent/owner-pod-turn-errors");
    expect(
      ownerPodTurnErrorMessage(
        "AGENT_PRIVATE_RUNTIME_REQUIRED",
        "AGENT_PRIVATE_RUNTIME_REQUIRED:pending",
      ),
    ).toContain("still being set up");
    expect(
      ownerPodTurnErrorMessage("x", "AGENT_PRIVATE_RUNTIME_REQUIRED:unplaced"),
    ).toContain("Choose where");
    expect(
      ownerPodTurnErrorMessage(
        "x",
        "AGENT_PRIVATE_RUNTIME_REQUIRED:hussh_pods",
      ),
    ).toContain("paused");
  });

  it("still lets a Shared owner use the hub tab and Memory preparation", async () => {
    calls.hosting = { hostingMode: "shared" };
    const { EmailChatService } =
      await import("@/lib/services/email-chat-service");
    await EmailChatService.chat({
      vaultOwnerToken: "t",
      vaultKey: VAULT_KEY,
      message: "hi",
    });
    const { previewAgentPkmMemory } =
      await import("@/lib/agent/agent-pkm-memory");
    await previewAgentPkmMemory({
      userId: "owner-a",
      message: "Synthetic notebook preference",
      currentDomains: [],
      vaultOwnerToken: "vault-owner-token",
    });
    expect(calls.hub).toEqual([
      "/api/one/email/chat",
      "/api/pkm/memory/proposals",
    ]);
    calls.hub.length = 0; // the afterEach guard is for private owners
  });
});

describe("voice commands and connector settings", () => {
  it("plans and checkpoints a typed command on the agent and runs its typed effect", async () => {
    const { PrivateLocationCommand } =
      await import("@/lib/agent/location-command-private");
    const checkpoint = {
      command_id: "0b6f6a1e-2f4c-4d1a-9a59-5f1f3c1e2d3b",
      revision: 1,
      next_step: 0,
      checkpoint_contract: "pod-command-recovery-v1",
    };
    calls.directReply = (route) =>
      route.endsWith("/capabilities")
        ? {
            identity: { type: "google-adk" },
            transport: { streaming: true },
            podCommandCheckpointVersion: 1,
          }
        : route.endsWith("/typed")
          ? {
              plan: {
                steps: [{ action_id: "location.open_now", slots: {} }],
                gate: null,
              },
              checkpoint,
            }
          : route.endsWith("/dispatch")
            ? {
                checkpoint: {
                  ...checkpoint,
                  revision: 2,
                  status: "dispatching",
                },
                operationId: `pod:${checkpoint.command_id}:0`,
              }
            : {
                checkpoint: {
                  ...checkpoint,
                  revision: 3,
                  next_step: 1,
                  status: "completed",
                },
              };
    const execute = vi.fn(async () => ({
      status: "succeeded",
      resultSummary: "Opened.",
    }));
    const present = vi.fn();
    const command = new PrivateLocationCommand({
      ports: {
        authority: () => ({
          userId: "owner-a",
          token: "fixture",
          vaultKey: "ab".repeat(32),
        }),
        execute: execute as never,
        navigate: vi.fn(async () => true),
        context: () => ({ screen: "location" }),
        present,
      },
      assess: vi.fn(),
      observations: () => [],
      transcript: () => "open location",
    });
    await command.submit({
      requestId: checkpoint.command_id,
      typedAction: { action_id: "location.open_now", slots: {} },
    });
    expect(calls.direct.map((call) => call.route)).toEqual([
      "agent-chat/capabilities",
      "agent-chat/proposals/typed",
      `agent-chat/proposals/${checkpoint.command_id}/dispatch`,
      `agent-chat/proposals/${checkpoint.command_id}/settle`,
    ]);
    expect(execute).toHaveBeenCalledWith(
      "location.open_now",
      {},
      expect.objectContaining({
        operationId: `pod:${checkpoint.command_id}:0`,
      }),
      expect.anything(),
    );
    expect(present).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "result", message: "Done." }),
    );
    expect(
      new Headers(calls.direct[0].init.headers).get("X-Hussh-Chat-Key"),
    ).toMatch(/^hck1\./);
  });

  it("restores an uncertain private dispatch without replaying its effect", async () => {
    const { PrivateLocationCommand } =
      await import("@/lib/agent/location-command-private");
    const checkpoint = {
      command_id: "saved-command",
      revision: 2,
      next_step: 0,
      status: "dispatching",
      checkpoint_contract: "pod-command-recovery-v1",
    };
    calls.directReply = () => ({
      checkpoint,
      plan: { steps: [{ action_id: "location.open_now", slots: {} }] },
    });
    const execute = vi.fn();
    const present = vi.fn();
    const command = new PrivateLocationCommand({
      ports: {
        authority: () => ({
          userId: "owner-a",
          token: "fixture",
          vaultKey: "ab".repeat(32),
        }),
        execute,
        navigate: vi.fn(),
        context: () => ({ screen: "location" }),
        present,
      },
      assess: vi.fn(),
      observations: () => [],
      transcript: () => "",
    });
    await command.resume(checkpoint as never);
    await command.continueGate(true);
    expect(execute).not.toHaveBeenCalled();
    expect(calls.direct.map((x) => x.route)).toEqual([
      "agent-chat/proposals/saved-command",
    ]);
    expect(present).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "result",
        message: expect.stringContaining("may already have happened"),
      }),
    );
  });

  it.each(["pause", "cancel", "owner change"])(
    "never executes a deferred dispatch after %s",
    async (interruption) => {
      const { PrivateLocationCommand } =
        await import("@/lib/agent/location-command-private");
      const checkpoint = {
        command_id: "deferred-command",
        revision: 1,
        next_step: 0,
        status: "ready",
        checkpoint_contract: "pod-command-recovery-v1",
      };
      let owner = "owner-a";
      const execute = vi.fn();
      const present = vi.fn();
      calls.directReply = (route) =>
        route.endsWith("/capabilities")
          ? {
              identity: { type: "google-adk" },
              transport: { streaming: true },
              podCommandCheckpointVersion: 1,
            }
          : route.endsWith("/typed")
            ? {
                checkpoint,
                plan: {
                  steps: [{ action_id: "location.open_now", slots: {} }],
                },
              }
            : route.endsWith("/dispatch")
              ? {
                  checkpoint: {
                    ...checkpoint,
                    status: "dispatching",
                    revision: 2,
                  },
                  operationId: "pod:deferred-command:0",
                }
              : { cancelled: true };
      let entered!: () => void;
      let release!: () => void;
      const parsing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi
        .spyOn(Response.prototype, "json")
        .mockImplementation(async function (this: Response) {
          const value = JSON.parse(await this.text());
          if (value.operationId) {
            entered();
            await delayed;
          }
          return value;
        });
      const command = new PrivateLocationCommand({
        ports: {
          authority: () => ({
            userId: owner,
            token: "fixture",
            vaultKey: "ab".repeat(32),
          }),
          execute,
          navigate: vi.fn(),
          context: () => ({ screen: "location" }),
          present,
        },
        assess: vi.fn(),
        observations: () => [],
        transcript: () => "",
      });
      try {
        const pending = command.submit({
          requestId: checkpoint.command_id,
          typedAction: { action_id: "location.open_now", slots: {} },
        });
        const refused = expect(pending).rejects.toThrow();
        await parsing;
        if (interruption === "owner change") owner = "owner-b";
        else if (interruption === "cancel") await command.cancel();
        else command.pause();
        release();
        await refused;
        expect(execute).not.toHaveBeenCalled();
        expect(calls.direct.some((x) => x.route.endsWith("/settle"))).toBe(
          false,
        );
      } finally {
        release();
        spy.mockRestore();
      }
    },
  );

  it.each(["legacy", "invalid discovery", "modern downgrade"])(
    "preserves command compatibility without unsafe recovery: %s",
    async (mode) => {
      const { PrivateLocationCommand } =
        await import("@/lib/agent/location-command-private");
      const checkpoint = {
        command_id: "legacy-command",
        revision: 1,
        next_step: 0,
        status: "ready",
      };
      calls.directReply = (route) =>
        route.endsWith("/capabilities")
          ? mode === "invalid discovery"
            ? {}
            : {
                identity: { type: "google-adk" },
                transport: { streaming: true },
                ...(mode === "modern downgrade"
                  ? { podCommandCheckpointVersion: 1 }
                  : {}),
              }
          : route.endsWith("/typed")
            ? {
                checkpoint,
                plan: {
                  steps: [{ action_id: "location.open_now", slots: {} }],
                },
              }
            : { checkpoint: { ...checkpoint, status: "completed" } };
      const execute = vi.fn(async () => ({ status: "succeeded" }));
      const command = new PrivateLocationCommand({
        ports: {
          authority: () => ({
            userId: "owner-a",
            token: "fixture",
            vaultKey: "ab".repeat(32),
          }),
          execute: execute as never,
          navigate: vi.fn(),
          context: () => ({}),
          present: vi.fn(),
        },
        assess: vi.fn(),
        observations: () => [],
        transcript: () => "",
      });
      const turn = command.submit({
        requestId: checkpoint.command_id,
        typedAction: { action_id: "location.open_now", slots: {} },
      });
      if (mode !== "legacy") {
        await expect(turn).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
        return;
      }
      await turn;
      expect(execute).toHaveBeenCalledTimes(1);
      const proposal = calls.direct.find((x) => x.route.endsWith("/typed"))!;
      expect(JSON.parse(proposal.init.body as string)).not.toHaveProperty(
        "checkpoint_contract",
      );
      expect(calls.direct.some((x) => x.route.endsWith("/dispatch"))).toBe(
        false,
      );
      calls.directReply = () => ({ checkpoint });
      await command.resume(checkpoint as never);
      await command.continueGate(true);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes a private connector's tools on the agent", async () => {
    const { connectorSettingsRequest } =
      await import("@/lib/services/private-connector-transport");
    await connectorSettingsRequest("custom_" + "a".repeat(32), "mcp/catalog", {
      method: "POST",
    });
    expect(calls.direct.map((call) => call.route)).toEqual([
      `agent-chat/connectors/custom_${"a".repeat(32)}/mcp/catalog`,
    ]);
    expect(
      calls.hub.filter((path) => path.startsWith("/api/connectors")),
    ).toEqual([]);
  });
});
