import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTransport = vi.hoisted(() => ({
  runAgent: vi.fn(),
  outcome: "success" as "success" | "interrupt",
  emitEvents: null as null | ((subscriber: Record<string, (input: any) => void>) => void),
  aborted: false,
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(public config: unknown) {}
    abortRun() {
      mockTransport.aborted = true;
    }
    async runAgent(parameters: unknown, subscriber: Record<string, (input: any) => void>) {
      mockTransport.runAgent(parameters, this.config);
      subscriber.onRunStartedEvent?.({ event: { type: "RUN_STARTED" } });
      if (mockTransport.emitEvents) {
        mockTransport.emitEvents(subscriber);
      }
      if (mockTransport.aborted) return;
      subscriber.onTextMessageContentEvent?.({
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
      });
      subscriber.onActivitySnapshotEvent?.({
        event: {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "activity-1",
          activityType: "one.scope_discovery.v1",
          content: {
            status: "ok",
            person: {
              displayName: "Alex Morgan",
              profilePath: "/people/1234567890abcdef",
              relationship: "connected",
            },
            requestableScopes: [],
          },
        },
      });
      if (mockTransport.outcome === "interrupt") {
        subscriber.onRunFinishedEvent?.({
          event: { type: "RUN_FINISHED" },
          outcome: "interrupt",
          interrupts: [{ id: "interrupt-1", toolCallId: "tool-1" }],
        });
        return;
      }
      subscriber.onRunFinishedEvent?.({
        event: { type: "RUN_FINISHED" },
        outcome: "success",
      });
    }
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetchStream: vi.fn(),
    listAgentChatConversations: vi.fn(),
    getAgentChatHistory: vi.fn(),
    renameAgentChatConversation: vi.fn(),
    deleteAgentChatConversation: vi.fn(),
  },
}));

import {
  formatAgentChatErrorMessage,
  getAgentChatHistory,
  streamAgentChat,
  streamAgentIntro,
  type SpecialistDirectiveEvent,
} from "@/lib/services/agent-chat-client";
import { ApiService } from "@/lib/services/api-service";

describe("AG-UI Agent One client", () => {
  it.each([
    { toolName: "ask_email_agent", connector: "mail", sourceRef: "mail:1", kind: "metadata", label: "Mail" },
    { toolName: "ask_documents_agent", connector: "drive", sourceRef: `document:${"a".repeat(32)}`, kind: "document", label: "Document" },
  ])("forwards safe $connector provenance without dispatching a smuggled action or storing tool text", async ({ toolName, connector, sourceRef, kind, label }) => {
    const onStructuredExperience = vi.fn();
    const onToolResult = vi.fn();
    const onToolWaiting = vi.fn();
    const onSpecialistDirective = vi.fn();
    mockTransport.emitEvents = (subscriber) => {
      subscriber.onToolCallStartEvent({ event: { toolCallId: "mail-call", toolCallName: toolName } });
      subscriber.onToolCallResultEvent({ event: { toolCallId: "mail-call", content: JSON.stringify({
        text: "PRIVATE_TOOL_RESULT", status: "ok", structured: {
          schema_version: "specialist_read.v1", connector, status: "ok",
          sources: [{ source_ref: sourceRef, label, kind }],
          truncated: false, metadata_only: connector === "mail",
        }, directive: { action_id: "route.profile", slots: {}, execution: "frontend" },
      }) } });
    };
    await streamAgentChat({ userId: "u1", message: "Read mail", vaultOwnerToken: "fixture",
      handlers: { onStructuredExperience, onToolResult, onToolWaiting, onSpecialistDirective } });
    expect(onStructuredExperience).toHaveBeenCalledWith(expect.objectContaining({
      type: "one.connector_read.v1", sourceRefs: [sourceRef],
    }), "mail-call");
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("PRIVATE_TOOL_RESULT");
    expect(onToolWaiting).not.toHaveBeenCalled();
    expect(onSpecialistDirective).not.toHaveBeenCalled();
  });

  it("restores only safe read receipts on assistant history", async () => {
    const specialist_read = { schema_version: "specialist_read.v1", connector: "mail", status: "ok",
      sources: [], truncated: false, metadata_only: true };
    vi.mocked(ApiService.getAgentChatHistory).mockResolvedValueOnce(new Response(JSON.stringify({
      messages: ["assistant", "user"].map((role) => ({ id: role, role, content: "Answer",
        metadata: { specialist_read, provider_subject: "PRIVATE" } })),
    })));
    const messages = await getAgentChatHistory({ conversationId: "c1", vaultOwnerToken: "fixture" });
    expect(messages[0].metadata?.connectorRead).toMatchObject({ type: "one.connector_read.v1", status: "ok" });
    expect(messages[1].metadata?.connectorRead).toBeNull();
    expect(JSON.stringify(messages)).not.toContain("PRIVATE");
  });
  beforeEach(() => {
    mockTransport.runAgent.mockClear();
    mockTransport.outcome = "success";
    mockTransport.emitEvents = null;
    mockTransport.aborted = false;
  });

  it("uses the canonical endpoint and official run fields", async () => {
    const tokens: string[] = [];
    const experiences: string[] = [];
    const experienceIds: Array<string | undefined> = [];
    const result = await streamAgentChat({
      userId: "user-1",
      message: "Hello",
      conversationId: "thread-1",
      vaultOwnerToken: "owner-token",
      screenContext: { available_action_ids: [] },
      handlers: {
        onToken: (token) => tokens.push(token),
        onStructuredExperience: (experience, eventId) => {
          experiences.push(experience.type);
          experienceIds.push(eventId);
        },
      },
    });

    expect(result).toEqual({
      conversationId: "thread-1",
      model: null,
      text: "Hello",
      interrupted: false,
    });
    expect(tokens).toEqual(["Hello"]);
    expect(experiences).toEqual(["one.scope_discovery.v1"]);
    expect(experienceIds).toEqual(["activity-1"]);
    expect(mockTransport.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [], context: [], forwardedProps: expect.any(Object) }),
      expect.objectContaining({ url: "/api/one/agent-chat", threadId: "thread-1" }),
    );
  });

  it.each(["invocation-1", " "])("keeps tool invocation identity across redelivery (%s)", async toolCallId => {
    mockTransport.emitEvents = subscriber => {
      subscriber.onToolCallStartEvent?.({event: {toolCallId, toolCallName: "discover_person_information"}});
      for (const messageId of ["transport-1", "transport-2"]) {
        subscriber.onToolCallResultEvent?.({event: {toolCallId, messageId, content: JSON.stringify({
          status: "ok", person: {displayName: "Alex", profilePath: "/people/1234567890abcdef", relationship: "connected"},
          requestableScopes: [],
        })}});
      }
    };
    const ids: Array<string | undefined> = [];
    await streamAgentChat({userId: "user-1", message: "Show available information", conversationId: "thread-1",
      vaultOwnerToken: "owner-token", handlers: {onStructuredExperience: (_, id) => ids.push(id)}});
    expect(ids.slice(0, 2)).toEqual(toolCallId.trim() ? ["invocation-1", "invocation-1"] : ["transport-1", "transport-2"]);
  });

  it("parses the materialized activity after an AG-UI JSON patch", async () => {
    const updatedLabel = "Professional role";
    mockTransport.emitEvents = subscriber => {
      subscriber.onActivityDeltaEvent?.({
        event: {
          type: "ACTIVITY_DELTA",
          messageId: "activity-delta-1",
          activityType: "one.scope_discovery.v1",
          patch: [
            {
              op: "replace",
              path: "/requestableScopes",
              value: [
                {
                  scopeRef: "attr.professional.role",
                  label: updatedLabel,
                  domain: "professional",
                  sensitivity: "standard",
                },
              ],
            },
          ],
        },
        activityMessage: {
          id: "activity-delta-1",
          role: "activity",
          activityType: "one.scope_discovery.v1",
          content: {
            status: "ok",
            person: {
              displayName: "Alex Morgan",
              profilePath: "/people/1234567890abcdef",
              relationship: "connected",
            },
            requestableScopes: [],
          },
        },
      });
    };

    const labels: string[] = [];
    await streamAgentChat({
      userId: "user-1",
      message: "List what Alex can share",
      conversationId: "thread-activity-delta",
      vaultOwnerToken: "owner-token",
      handlers: {
        onStructuredExperience: experience => {
          if (experience.type === "one.scope_discovery.v1") {
            labels.push(...experience.scopes.map(scope => scope.label));
          }
        },
      },
    });

    expect(labels[0]).toBe(updatedLabel);
  });

  it("forwards the versioned agent-safe PKM packet on every chat turn", async () => {
    const pkmContext = "Private-agent PKM context (agent-safe-pkm/v1):\n- Preferences > Tone: concise";

    await streamAgentChat({
      userId: "user-1",
      message: "What tone do I prefer?",
      conversationId: "thread-1",
      vaultOwnerToken: "owner-token",
      pkmContext,
      handlers: {},
    });

    expect(mockTransport.runAgent.mock.calls[0]?.[0]).toMatchObject({
      forwardedProps: expect.objectContaining({ pkmContext }),
    });
  });

  it("uses the same AG-UI endpoint before vault unlock", async () => {
    await expect(streamAgentIntro({ message: "What is Hussh?" })).resolves.toMatchObject({
      text: "Hello",
    });
    expect(mockTransport.runAgent.mock.calls[0]?.[1]).toMatchObject({ url: "/api/one/agent-chat" });
  });

  it.each(["full", "intro"])("drops reasoning before SDK storage in the %s tier", async (tier) => {
    const privateMessage = { id: "r1", role: "reasoning", content: "Private reasoning" };
    const answer = { id: "a1", role: "assistant", content: "Public answer" };
    mockTransport.emitEvents = (subscriber) => {
      for (const type of [
        "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END", "REASONING_MESSAGE_CHUNK", "REASONING_END",
        "REASONING_ENCRYPTED_VALUE",
      ]) {
        expect(subscriber.onEvent({ event: { type } })).toEqual({ stopPropagation: true });
      }
      expect(subscriber.onMessagesSnapshotEvent({ event: { messages: [privateMessage, answer] }, messages: [] }))
        .toEqual({ messages: [answer], stopPropagation: true });
      const activity = { id: "activity-1", role: "activity", content: { status: "working" } };
      expect(subscriber.onMessagesSnapshotEvent({
        event: { messages: [privateMessage, answer] }, messages: [activity, privateMessage],
      })).toEqual({ messages: [activity, answer], stopPropagation: true });
      expect(subscriber.onMessagesSnapshotEvent({ event: { messages: [answer] }, messages: [activity] }))
        .toBeUndefined();
      expect(subscriber.onEvent({ event: { type: "TOOL_CALL_RESULT" } })).toBeUndefined();
      expect(subscriber.onReasoningMessageContentEvent).toBeUndefined();
    };
    const result = tier === "intro"
      ? await streamAgentIntro({ message: "Hello" })
      : await streamAgentChat({ userId: "u1", message: "Hello", vaultOwnerToken: "owner-token" });
    expect(result.text).toBe("Hello");
    expect(privateMessage.content).toBe("Private reasoning");
  });

  it("projects legacy history before messages reach UI caches", async () => {
    vi.mocked(ApiService.getAgentChatHistory).mockResolvedValueOnce(new Response(JSON.stringify({
      messages: [
        { id: "r1", role: "reasoning", content: "Private reasoning" },
        { id: "a1", conversation_id: "c1", role: "assistant", status: "complete",
          content: "Public answer", thought: "Private reasoning", reasoning: "Private reasoning",
          metadata: { kind: "answer", thought: "Private reasoning" } },
      ],
    })));
    const messages = await getAgentChatHistory({ conversationId: "c1", vaultOwnerToken: "owner-token" });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Public answer");
    expect(JSON.stringify(messages)).not.toContain("Private reasoning");
  });

  it("never exposes unknown AG-UI runtime errors to the transcript", () => {
    const raw =
      'DB operation failed [<raw_sql>.execute_raw]: INSERT INTO one_adk_sessions [parameters: {"user":"owner-1","ciphertext":"secret"}]';

    const visible = formatAgentChatErrorMessage(raw);

    expect(visible).toBe("One couldn't complete that response. Please try again.");
    expect(visible).not.toContain("one_adk_sessions");
    expect(visible).not.toContain("owner-1");
    expect(visible).not.toContain("ciphertext");
  });

  it("maps typed database failures to stable actionable copy", () => {
    expect(
      formatAgentChatErrorMessage("private database detail", "DATABASE_EXECUTION_ERROR"),
    ).toBe("One's conversation history is temporarily unavailable. Please try again.");
  });

  it("maps untyped provider capacity failures without exposing runtime details", () => {
    const visible = formatAgentChatErrorMessage(
      "429 Too Many Requests: RESOURCE_EXHAUSTED",
    );

    expect(visible).toBe("One is temporarily at capacity. Please try again in a moment.");
    expect(visible).not.toContain("RESOURCE_EXHAUSTED");
    expect(visible).not.toContain("429");
  });

  it("settles an interrupted HITL turn while preserving its resumable boundary", async () => {
    mockTransport.outcome = "interrupt";
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onInterrupt = vi.fn(() => controller.abort());

    const result = await streamAgentChat({
      userId: "user-1",
      message: "Request access",
      conversationId: "thread-hitl",
      vaultOwnerToken: "owner-token",
      signal: controller.signal,
      handlers: { onComplete, onInterrupt },
    });

    expect(onInterrupt).toHaveBeenCalledWith({ conversationId: "thread-hitl" });
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
  });

  it("emits onSpecialistDirective when a pending directive arrives via state delta", async () => {
    mockTransport.emitEvents = (subscriber) => {
      subscriber.onStateDeltaEvent?.({
        event: {
          type: "STATE_DELTA",
          delta: [
            {
              op: "add",
              path: "/hussh:pending_directive:calendar",
              value: {
                kind: "action",
                delegateAgentId: "agent_calendar",
                payload: {
                  type: "calendar.execute_proposal",
                  proposalId: "gcal_test_123",
                  summary: "Schedule 'Study Session'",
                  confirmLabel: "Schedule",
                },
              },
            },
          ],
        },
      });
    };

    const directives: SpecialistDirectiveEvent[] = [];
    await streamAgentChat({
      userId: "user-1",
      message: "Schedule a study session",
      conversationId: "thread-directive",
      vaultOwnerToken: "owner-token",
      handlers: {
        onSpecialistDirective: (directive) => directives.push(directive),
      },
    });

    expect(directives).toEqual([
      {
        delegateAgentId: "agent_calendar",
        directive: {
          kind: "action",
          payload: {
            type: "calendar.execute_proposal",
            proposalId: "gcal_test_123",
            summary: "Schedule 'Study Session'",
            confirmLabel: "Schedule",
          },
        },
        message: "Schedule 'Study Session'",
        stateChanged: true,
      },
    ]);
  });

  it("stages a server-resolved action directive from state without a second model call", async () => {
    mockTransport.emitEvents = (subscriber) => {
      subscriber.onStateDeltaEvent?.({
        event: {
          type: "STATE_DELTA",
          delta: [
            {
              op: "add",
              path: "/hussh:pending_directive:consent.request",
              value: {
                kind: "action",
                payload: {
                  actionId: "consent.request",
                  slots: {
                    personRef: "person_1234567890123456",
                    scopeRefs: ["opaque_scope"],
                    purpose: "Review a role opportunity",
                    durationHours: 48,
                    idempotencyKey: "agent-chat-proposal-1234567890",
                  },
                  needsConfirmation: true,
                  trustedActivationRequired: false,
                },
              },
            },
          ],
        },
      });
    };

    const waiting: Array<Record<string, unknown>> = [];
    await streamAgentChat({
      userId: "user-1",
      message: "Ask Alex for employment status",
      conversationId: "thread-consent",
      vaultOwnerToken: "owner-token",
      handlers: { onToolWaiting: (event) => waiting.push(event as unknown as Record<string, unknown>) },
    });

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      actionId: "consent.request",
      requiresConfirmation: true,
      slots: {
        personRef: "person_1234567890123456",
        scopeRefs: ["opaque_scope"],
      },
    });
  });

  it("settles a synthetic confirmation turn when the card is staged", async () => {
    mockTransport.emitEvents = subscriber => {
      subscriber.onToolCallStartEvent?.({
        event: { toolCallId: "tool-confirm", toolCallName: "run_app_action" },
      });
      subscriber.onToolCallResultEvent?.({
        event: {
          toolCallId: "tool-confirm",
          messageId: "tool-result",
          content: JSON.stringify({
            status: "confirm_pending",
            directive: {
              actionId: "consent.cancel_request",
              slots: { bundleId: "opaque-bundle" },
              needsConfirmation: true,
            },
          }),
        },
      });
    };

    const waiting = vi.fn();
    const onInterrupt = vi.fn();
    const onComplete = vi.fn();
    const result = await streamAgentChat({
      userId: "user-1",
      message: "Cancel that request I just sent",
      conversationId: "thread-confirm",
      vaultOwnerToken: "owner-token",
      handlers: { onToolWaiting: waiting, onInterrupt, onComplete },
    });

    expect(waiting).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "consent.cancel_request",
        requiresConfirmation: true,
      }),
    );
    expect(onInterrupt).toHaveBeenCalledWith({ conversationId: "thread-confirm" });
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
  });

  it("accepts only the consent proposal directive from a proposal result", async () => {
    const { parseParkedAppActionDirective } = await import(
      "@/lib/services/agent-chat-client"
    );
    expect(
      parseParkedAppActionDirective({
        status: "proposal_ready",
        directive: {
          actionId: "consent.request",
          slots: { proposal_id: "opaque-proposal" },
          needsConfirmation: true,
        },
      }),
    ).toMatchObject({
      actionId: "consent.request",
      needsConfirmation: true,
      slots: { proposal_id: "opaque-proposal" },
    });
    expect(
      parseParkedAppActionDirective({
        status: "proposal_ready",
        directive: {
          actionId: "consent.request",
          slots: { proposal_id: "opaque-proposal" },
          needsConfirmation: false,
        },
      }),
    ).toBeNull();
  });

  it("unwraps the canonical nested and snake-case parked action result without authorizing it", async () => {
    const { parseParkedAppActionDirective } = await import(
      "@/lib/services/agent-chat-client"
    );
    expect(
      parseParkedAppActionDirective(
        JSON.stringify({
          result: {
            status: "confirm_pending",
            directive: {
              action_id: "consent.cancel_request",
              slot_values: { bundle_id: "opaque-bundle" },
              needs_confirmation: true,
              trusted_activation_required: false,
            },
          },
        }),
      ),
    ).toMatchObject({
      actionId: "consent.cancel_request",
      needsConfirmation: true,
      slots: { bundle_id: "opaque-bundle" },
      trustedActivationRequired: false,
    });
  });
});

describe("parsePendingConsentRequestIds", () => {
  it("reads request ids only from the pending-requests tool and dedupes them", async () => {
    const { parsePendingConsentRequestIds } = await import("@/lib/services/agent-chat-client");
    const content = JSON.stringify({
      status: "ok",
      pendingRequestIds: ["req_1", "req_1", " req_2 ", ""],
      pendingRequests: [{ requestId: "req_1", requesterLabel: "Alex" }],
    });
    expect(parsePendingConsentRequestIds("list_pending_information_requests", content)).toEqual([
      "req_1",
      "req_2",
    ]);
    expect(parsePendingConsentRequestIds("discover_person_information", content)).toEqual([]);
    expect(
      parsePendingConsentRequestIds(
        "list_pending_information_requests",
        JSON.stringify({ status: "failed", pendingRequestIds: ["req_1"] }),
      ),
    ).toEqual([]);
    expect(parsePendingConsentRequestIds("list_pending_information_requests", "not json")).toEqual([]);
  });
});
