import { beforeEach, describe, expect, it, vi } from "vitest";

import { planOneGoal } from "@/lib/one-goal/one-goal-planner";
import { runOneGoal } from "@/lib/one-goal/one-goal-runner";
import { useOneGoalSessionStore } from "@/lib/one-goal/one-goal-session-store";

const agentChatMocks = vi.hoisted(() => ({
  streamAgentChat: vi.fn(),
}));

vi.mock("@/lib/services/agent-chat-client", () => ({
  streamAgentChat: agentChatMocks.streamAgentChat,
}));

vi.mock("@/lib/services/kai-service", () => ({
  getStockContext: vi.fn().mockResolvedValue({
    ticker: "TSLA",
    user_risk_profile: "balanced",
    holdings: [],
    recent_decisions: [],
    portfolio_allocation: {
      equities_pct: 0,
      bonds_pct: 0,
      cash_pct: 100,
    },
  }),
}));

vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: {
    ensureRun: vi.fn().mockResolvedValue({
      kind: "started",
      task: {
        runId: "run_tsla",
        userId: "user_1",
        debateSessionId: "debate_session_1",
        ticker: "TSLA",
        status: "running",
        startedAt: "2026-07-06T00:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-07-06T00:00:00.000Z",
        latestCursor: 0,
        persistenceState: "none",
        persistenceError: null,
        dismissedAt: null,
        finalDecision: null,
      },
    }),
    subscribeRunEvents: vi.fn(() => () => {}),
    getTask: vi.fn(() => null),
    getActiveTaskForUser: vi.fn(() => null),
    cancelRun: vi.fn(),
  },
}));

describe("runOneGoal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentChatMocks.streamAgentChat.mockResolvedValue({
      conversationId: "conversation-specialist",
      model: "one+specialist",
      text: "Specialist answer.",
    });
    useOneGoalSessionStore.setState({
      sessions: [],
      activeSessionId: null,
    });
  });

  it("wraps a generated one-step action in a goal session", async () => {
    const plan = planOneGoal({
      actionId: "route.profile",
      entrypoint: "ui",
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    const executeAction = vi.fn().mockResolvedValue({
      status: "started",
      actionId: "route.profile",
      label: "Open Profile",
      routeBefore: "/one",
      routeAfter: "/profile",
      screenBefore: "one_agents",
      screenAfter: "profile",
      resultSummary: "Profile opened in One.",
      data: {
        goal_id: "goal.route.profile",
      },
    });
    const finalText = vi.fn();

    const result = await runOneGoal({
      plan,
      userId: "user_1",
      vaultOwnerToken: "token",
      executeAction,
      callbacks: {
        onFinalText: finalText,
      },
    });

    expect(executeAction).toHaveBeenCalledWith("route.profile", {});
    expect(result.session.goalId).toBe("goal.route.profile");
    expect(result.session.state).toBe("completed");
    expect(result.session.events.map((event) => event.state)).toEqual([
      "started",
      "completed",
    ]);
    expect(finalText).toHaveBeenCalledWith("Profile opened in One.");
  });

  it("settles long-running analysis into the debate workspace before backend hydration completes", async () => {
    const plan = planOneGoal({
      transcript: "Analyze TSLA using default",
      entrypoint: "voice",
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    const router = {
      push: vi.fn(),
    };
    const setAnalysisParams = vi.fn();
    const executeAction = vi.fn().mockResolvedValue({
      status: "started",
      actionId: "analysis.start",
      label: "Start Stock Analysis",
      routeBefore: "/one/kai",
      routeAfter: "/kai?tab=analysis&ticker=TSLA",
      screenBefore: "kai_market",
      screenAfter: "kai_analysis",
      resultSummary: "Opened the TSLA comparison preview before starting the debate.",
      data: {
        goal_id: "goal.analysis.start_debate",
      },
    });
    const progressText = vi.fn();

    const result = await runOneGoal({
      plan,
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      router,
      setAnalysisParams,
      executeAction,
      waitForCompletion: false,
      callbacks: {
        onProgressText: progressText,
      },
    });

    expect(router.push).toHaveBeenCalledWith("/kai?tab=analysis&focus=active&ticker=TSLA");
    expect(setAnalysisParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ticker: "TSLA",
        launchConfirmed: true,
        pickSource: "default",
        userContext: {},
      })
    );
    expect(progressText).toHaveBeenCalledWith(
      "Opening the TSLA debate workspace while Kai hydrates context."
    );
    expect(result.actionResult).toMatchObject({
      status: "started",
      routeAfter: "/kai?tab=analysis&focus=active&ticker=TSLA",
    });
  });

  it("runs read-only specialist chat goals through Agent Chat A2A", async () => {
    agentChatMocks.streamAgentChat.mockResolvedValueOnce({
      conversationId: "conversation-email",
      model: "one+email",
      text: "Two threads need a reply today.",
    });
    const plan = planOneGoal({
      transcript: "What needs a reply today?",
      entrypoint: "voice",
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    const finalText = vi.fn();
    const executeAction = vi.fn();
    const result = await runOneGoal({
      plan,
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      screenContext: { route: { pathname: "/one/gmail" } },
      executeAction,
      callbacks: {
        onFinalText: finalText,
      },
    });

    expect(executeAction).not.toHaveBeenCalled();
    expect(agentChatMocks.streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        message: "What needs a reply today?",
        vaultOwnerToken: "vault_token",
        delegateAgentId: "agent_email",
        screenContext: { route: { pathname: "/one/gmail" } },
      })
    );
    expect(result.session.state).toBe("completed");
    expect(result.actionResult).toMatchObject({
      status: "succeeded",
      actionId: "email.chat.turn",
      resultSummary: "Two threads need a reply today.",
    });
    expect(finalText).toHaveBeenCalledWith("Two threads need a reply today.");
  });

  it("turns specialist directives into chat handoff results", async () => {
    const specialistDirective = {
      delegateAgentId: "agent_location",
      directive: {
        kind: "action" as const,
        payload: {
          id: "share-1",
          type: "publish_share",
        },
      },
      message: "Review this location share before I start it.",
      stateChanged: false,
    };
    agentChatMocks.streamAgentChat.mockImplementationOnce(async (input) => {
      input.handlers?.onSpecialistDirective?.(specialistDirective);
      return {
        conversationId: "conversation-location",
        model: "one+location",
        text: "Review this location share before I start it.",
      };
    });
    const plan = planOneGoal({
      transcript: "Start sharing my location with Rohan",
      entrypoint: "voice",
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    const result = await runOneGoal({
      plan,
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      executeAction: vi.fn(),
    });

    expect(agentChatMocks.streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        delegateAgentId: "agent_location",
        message: "Start sharing my location with Rohan",
      })
    );
    expect(result.session.state).toBe("blocked");
    expect(result.actionResult).toMatchObject({
      status: "blocked",
      actionId: "location.chat.turn",
      reason: "specialist_directive_requires_chat",
      data: {
        requiresChatHandoff: true,
        specialistDirective,
      },
    });
  });
});
