import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
} from "@/lib/agent/agent-action-runtime";
import {
  registerLocalOnboardingHandler,
  resolveLocalOnboardingHandler,
  useLocalOnboardingActionHandler,
  unregisterLocalOnboardingHandler,
} from "@/lib/agent/local-onboarding-actions";
import { buildKaiMarketRoute, ROUTES } from "@/lib/navigation/routes";
import { locationReviewActionForLegacyDirective, locationReviewForLegacyAction } from "@/lib/agent/main-chat-location-contract";
import { listKaiActions } from "@/lib/kai/actions/kai-action-gateway";
import { runtimeState } from "./agent-action-runtime-fixture";

describe("executeAgentGatewayAction", () => {
  it.each([[true, "profile_account", "started"], [false, "profile_account", "blocked"], [true, "chat", "blocked"]] as const)("uses the mounted name-review seam: mounted=%s screen=%s", async (mounted, screen, expected) => {
    const actionId = "profile.update_display_name";
    const handler = vi.fn(async () => ({ status: "started" as const, summary: "Review the proposed name and Save. Your name has not changed yet." }));
    if (mounted) registerLocalOnboardingHandler(actionId, handler);
    try {
      const result = await executeAgentGatewayAction({
        actionId, slots: { display_name: "Mira Iyer" }, allowedActionIds: screen === "profile_account" ? [actionId] : [], userId: "user_1", router: { push: vi.fn() },
        appRuntimeState: runtimeState({ route: { pathname: "/one/profile", screen } }),
        hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
      });
      expect(result.status).toBe(expected);
      if (expected === "started") expect(handler).toHaveBeenCalledExactlyOnceWith({ display_name: "Mira Iyer" }, undefined);
      else expect(handler).not.toHaveBeenCalled();
    } finally { if (mounted) unregisterLocalOnboardingHandler(actionId, handler); }
  });

  it.each([
    ["ria.picks.open_category_avoid", "/ria/picks?source=my&category=top-picks&search=1&share=private", "avoid", "my"],
    ["ria.picks.open_source_kai", "/ria/picks?source=my&category=avoid&search=1&share=private", "avoid", "kai"],
  ])("%s preserves the other public Picks dimension without carrying private query state", async (actionId, href, category, source) => {
    const previous = window.location.href;
    window.history.replaceState(null, "", href);
    try {
      const router = { push: vi.fn() };
      const result = await executeAgentGatewayAction({
        actionId, allowedActionIds: [], userId: "user_1", router,
        appRuntimeState: runtimeState({
          route: { pathname: "/ria/picks", screen: "ria_picks" },
          persona: { active: "ria", primary_nav: "ria", available: ["ria"], ria_switch_available: true, ria_setup_available: false },
        }),
        hasPortfolioData: true, busyOperations: {}, setAnalysisParams: vi.fn(),
      });
      expect(result.status).toBe("started");
      const target = new URL(router.push.mock.calls[0][0], window.location.origin);
      expect(Object.fromEntries(target.searchParams)).toEqual({ category, source });
      expect(result.routeAfter).toBe(target.pathname + target.search);
    } finally { window.history.replaceState(null, "", previous); }
  });

  it("never names a surface the action did not open", async () => {
    // Regression: this runtime was Kai-only once, and every route action
    // reported `${label} opened in Finance.` long after it became the shared
    // path for every surface. Asking for Voice Settings answered "Open Voice
    // Settings opened in Finance."
    //
    // The action's own surface_id is no better -- it names where the action is
    // authored, not where it lands, so route.voice_settings would claim
    // "Agents". The summary names no place at all now.
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.voice_settings",
      allowedActionIds: [],
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(result.status).toBe("started");
    expect(result.resultSummary).not.toMatch(/Finance/i);
    expect(result.resultSummary).not.toMatch(/Agents/i);
    // The label alone is the honest description of what happened.
    expect(result.resultSummary).toBe("Open Voice Settings.");
  });

  it("admits generated direct route actions outside the current screen inventory", async () => {
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.one_location",
      allowedActionIds: [],
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(router.push).toHaveBeenCalledWith(ROUTES.ONE_LOCATION);
    expect(result).toMatchObject({
      status: "started",
      actionId: "route.one_location",
      routeAfter: ROUTES.ONE_LOCATION,
    });
  });

  it.each([
    ["location.open_share", "share_options", "share"],
    ["location.open_ask", "ask", "ask"],
    ["location.open_sos", "sos_review", "sos"],
    ["location.open_ratings", "manage_ratings", "ratings"],
    ["location.open_invite", "manage_contacts", "invite"],
    ["location.review_notifications", "manage_settings", "settings"],
  ])("shows legacy Main Chat %s as an inline review and preserves legacy surface navigation", async (actionId, action, routeQuery) => {
    const router = { push: vi.fn() };
    const openMainChatLocationReview = vi.fn(() => true);
    const input = {
      actionId, allowedActionIds: [], userId: "user_1", router,
      slots: { confirmed: true, recipientUserId: "invented-id" },
      appRuntimeState: runtimeState(), hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
    };
    const result = await executeAgentGatewayAction({ ...input, openMainChatLocationReview });
    expect(result).toMatchObject({ status: "started", resultSummary: "Review the Location action here in Chat." });
    expect(result.routeAfter).toBeUndefined();
    expect(openMainChatLocationReview).toHaveBeenCalledExactlyOnceWith({ action, id: expect.any(String) });
    expect(router.push).not.toHaveBeenCalled();

    const other = await executeAgentGatewayAction(input);
    expect(other.status).toBe("started");
    expect(new URL(router.push.mock.calls[0]![0], window.location.origin).searchParams.get("action")).toBe(routeQuery);
  });

  it.each([
    ["location.select_share_recipient", "share_private"],
    ["location.select_ask_recipient", "ask"],
  ])("maps legacy %s selection hints without opening the Location route", async (actionId, action) => {
    const router = { push: vi.fn() };
    const openMainChatLocationReview = vi.fn(() => true);
    const input = {
      actionId, slots: { person: "Neelesh and Maya", circle: "Family", resolvedRecipientId: "a private id" },
      userId: "user_1", router, openMainChatLocationReview, appRuntimeState: runtimeState(),
      surfaceMetadata: { screenId: "chat", actions: [{ id: "route.profile", label: "Profile" }] },
      hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
    };
    const result = await executeAgentGatewayAction(input);
    expect(result.status).toBe("started");
    expect(openMainChatLocationReview).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String), action, people: ["Neelesh", "Maya"], circles: ["Family"],
    });
    expect(router.push).not.toHaveBeenCalled();

    openMainChatLocationReview.mockClear();
    const denied = await executeAgentGatewayAction({ ...input, allowedActionIds: [] });
    expect(denied).toMatchObject({ status: "blocked", reason: "action_not_in_active_inventory" });
    expect(openMainChatLocationReview).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("prepares a new review for a legacy request and leaves claimed operations with their existing handler", async () => {
    const actionId = "location.send_request";
    const router = { push: vi.fn() };
    const openMainChatLocationReview = vi.fn(() => true);
    const handler = vi.fn(async () => ({ status: "succeeded" as const, summary: "Request sent." }));
    registerLocalOnboardingHandler(actionId, handler);
    try {
      const input = {
        actionId, allowedActionIds: [actionId], slots: { person: "Neelesh", duration_hours: "0.5", confirmed: true },
        userId: "user_1", router, openMainChatLocationReview, appRuntimeState: runtimeState(),
        hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
      };
      const review = await executeAgentGatewayAction(input);
      expect(review.status).toBe("started");
      expect(openMainChatLocationReview).toHaveBeenCalledExactlyOnceWith({
        id: expect.any(String), action: "ask", people: ["Neelesh"], durationHours: 0.5,
      });
      expect(handler).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();

      openMainChatLocationReview.mockClear();
      const claimed = await executeAgentGatewayAction({ ...input, executionContext: { operationId: "claimed-operation" } });
      expect(claimed.status).toBe("succeeded");
      expect(handler).toHaveBeenCalledExactlyOnceWith(input.slots, { operationId: "claimed-operation" });
      expect(openMainChatLocationReview).not.toHaveBeenCalled();
    } finally {
      unregisterLocalOnboardingHandler(actionId, handler);
    }
  });

  it("keeps a mapped Location review blocked by an active overlay or mismatched owner", async () => {
    const actionId = "location.open_sos";
    const router = { push: vi.fn() };
    const openMainChatLocationReview = vi.fn(() => true);
    const input = {
      actionId, allowedActionIds: [actionId], userId: "user_1", router, openMainChatLocationReview,
      appRuntimeState: runtimeState(), hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
    };
    const modal = await executeAgentGatewayAction({
      ...input,
      surfaceMetadata: { interactionLayer: {
        schemaVersion: "voice_interaction_layer.v1", id: "active-review", kind: "vault",
        modality: "blocking", lifecycle: "open", blocksUnderlyingActions: true,
        visibleActionIds: [], visibleControlIds: [], options: [], dismissible: false, agentContinuity: "suppressed",
      } },
    });
    expect(modal).toMatchObject({ status: "blocked", reason: "action_not_in_active_inventory" });
    const wrongOwner = await executeAgentGatewayAction({ ...input, userId: "other-owner" });
    expect(wrongOwner).toMatchObject({ status: "blocked", reason: "main_chat_review_unavailable" });
    expect(openMainChatLocationReview).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("recognizes legacy save-my-soul and permission as review-only Location specialist actions", () => {
    const location = (type: string, delegateAgentId = "agent_location") => ({
      delegateAgentId, directive: { kind: "action", payload: { type } },
    });
    expect(locationReviewActionForLegacyDirective(location("sos_panic"))).toBe("sos_review");
    expect(locationReviewActionForLegacyDirective(location("request_device_location_permission"))).toBe("enable_device_location");
    expect(locationReviewActionForLegacyDirective(location("sos_panic", "agent_calendar"))).toBeNull();
    expect(locationReviewActionForLegacyDirective(location("publish_share"))).toBeNull();
  });

  it("keeps every wired legacy Location workspace local command on its inline review before a claim", async () => {
    const commands = listKaiActions().filter((action) =>
      action.surface_id === "one_location" && action.command?.domain === "location" &&
      action.execution_target.status === "wired" && action.execution_target.path === "local_handler",
    );
    expect(commands.map((action) => action.action_id)).toContain("location.trigger_sos");
    const router = { push: vi.fn() };
    const openMainChatLocationReview = vi.fn(() => true);
    const input = {
      userId: "user_1", router, openMainChatLocationReview, appRuntimeState: runtimeState(),
      hasPortfolioData: false, busyOperations: {}, setAnalysisParams: vi.fn(),
    };
    for (const command of commands) {
      const actionId = command.action_id;
      const result = await executeAgentGatewayAction({ ...input, actionId, allowedActionIds: [actionId] });
      expect(result, actionId).toMatchObject({ status: "started", resultSummary: "Review the Location action here in Chat." });
      expect(result.routeAfter).toBeUndefined();
    }
    expect(openMainChatLocationReview).toHaveBeenCalledTimes(commands.length);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("preserves Circle hints and never imports old SOS audiences or delivery claims", () => {
    expect(locationReviewForLegacyAction("location.create_circle", "local_handler", { name: "Family" })?.draft)
      .toEqual({ action: "manage_circles", circles: ["Family"] });
    expect(locationReviewForLegacyAction("location.add_to_circle", "local_handler", { person: "Maya", circle: "Family" })?.draft)
      .toEqual({ action: "manage_circles", people: ["Maya"], circles: ["Family"] });
    expect(locationReviewForLegacyAction("location.trigger_sos", "local_handler", {
      person: "Maya", confirmed: true, note: "Example alert",
    })?.draft).toEqual({ action: "sos_review" });
    expect(locationReviewForLegacyAction("location.add_emergency_contact", "local_handler", { person: "Maya" })?.draft)
      .toEqual({ action: "sms_contacts" });
    expect(locationReviewForLegacyAction("location.setup.start", "route")?.draft).toEqual({ action: "setup_location" });
    expect(locationReviewForLegacyAction("location.open_now", "route")).toBeNull();
  });

  it("refuses a route template it cannot fill instead of pushing it literally", async () => {
    // route.person_profile targets /people/[personRef]; typed search can pick
    // it, and a literal push opened a broken page (or the owner's own).
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.person_profile",
      allowedActionIds: [],
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      actionId: "route.person_profile",
      reason: "route_needs_entity",
    });
  });

  it("keeps global route actions blocked behind an active blocking layer", async () => {
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.one_location",
      allowedActionIds: [],
      surfaceMetadata: {
        interactionLayer: {
          schemaVersion: "voice_interaction_layer.v1",
          id: "vault-unlock",
          kind: "vault",
          modality: "blocking",
          lifecycle: "open",
          dismissible: false,
          visibleActionIds: [],
          visibleControlIds: [],
          options: [],
          blocksUnderlyingActions: true,
          agentContinuity: "suppressed",
        },
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "blocked",
      actionId: "route.one_location",
      reason: "action_not_in_active_inventory",
    });
  });

  it("routes Agent analysis.start tools to the comparison preview before debate launch", async () => {
    const router = {
      push: vi.fn(),
    };
    const setAnalysisParams = vi.fn();

    const result = await executeAgentGatewayAction({
      actionId: "analysis.start",
      slots: {
        symbol: "nvda",
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams,
    });

    expect(setAnalysisParams).toHaveBeenCalledWith(null);
    expect(router.push).toHaveBeenCalledWith(
      buildKaiMarketRoute("analysis", { ticker: "NVDA" }),
    );
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: buildKaiMarketRoute("analysis", { ticker: "NVDA" }),
      screenAfter: "kai_analysis",
      resultSummary:
        "Opened the NVDA comparison preview before starting the debate.",
    });
  });

  it("syncs to the investor workspace before running direct finance actions from RIA", async () => {
    const router = {
      push: vi.fn(),
    };
    const setAnalysisParams = vi.fn();
    const switchPersona = vi.fn(async () => null);

    const result = await executeAgentGatewayAction({
      actionId: "analysis.start",
      slots: {
        symbol: "tsla",
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState({
        persona: {
          active: "ria",
          primary_nav: "ria",
          available: ["ria", "investor"],
          transition_target: null,
          ria_switch_available: true,
          ria_setup_available: false,
        },
      }),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams,
      switchPersona,
    });

    expect(switchPersona).toHaveBeenCalledWith("investor");
    expect(router.push).toHaveBeenCalledWith(
      buildKaiMarketRoute("analysis", { ticker: "TSLA" }),
    );
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: buildKaiMarketRoute("analysis", { ticker: "TSLA" }),
      screenAfter: "kai_analysis",
    });
  });

  it("forwards directive correlation to provider local handlers without placing it in slots", async () => {
    const router = { push: vi.fn() };
    const handler = vi.fn().mockResolvedValue({
      status: "started",
      summary: "Google sign-in is opening.",
    });
    registerLocalOnboardingHandler("auth.sign_in_google", handler);

    try {
      const result = await executeAgentGatewayAction({
        actionId: "auth.sign_in_google",
        slots: {},
        executionContext: { directiveId: "directive-123" },
        userId: "user_1",
        router,
        appRuntimeState: runtimeState({
          route: { pathname: "/login", screen: "login", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(handler).toHaveBeenCalledWith(
        {},
        { directiveId: "directive-123" },
      );
      expect(result).toMatchObject({
        status: "started",
        actionId: "auth.sign_in_google",
      });
    } finally {
      unregisterLocalOnboardingHandler("auth.sign_in_google", handler);
    }
  });

  it("invokes a trusted provider handler synchronously from the confirming tap", async () => {
    const router = { push: vi.fn() };
    let invoked = false;
    let settle:
      ((value: { status: "started"; summary: string }) => void) | null = null;
    const handler = vi.fn(() => {
      invoked = true;
      return new Promise<{ status: "started"; summary: string }>((resolve) => {
        settle = resolve;
      });
    });
    registerLocalOnboardingHandler("auth.sign_in_apple", handler);

    try {
      const resultPromise = executeTrustedActivationGatewayAction({
        actionId: "auth.sign_in_apple",
        slots: {},
        executionContext: { directiveId: "directive-apple" },
        userId: "",
        router,
        appRuntimeState: runtimeState({
          auth: { signed_in: false, user_id: null },
          vault: {
            unlocked: false,
            token_available: false,
            token_valid: false,
          },
          route: { pathname: "/login", screen: "login", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(invoked).toBe(true);
      settle?.({ status: "started", summary: "Apple popup opened." });
      await expect(resultPromise).resolves.toMatchObject({
        status: "started",
        actionId: "auth.sign_in_apple",
      });
    } finally {
      unregisterLocalOnboardingHandler("auth.sign_in_apple", handler);
    }
  });

  it("settles the root claim action through its local handler", async () => {
    const router = { push: vi.fn() };
    const handler = vi.fn().mockResolvedValue({
      status: "started",
      summary: "Opening sign-in.",
    });
    registerLocalOnboardingHandler("onboarding.claim_one", handler);

    try {
      const result = await executeAgentGatewayAction({
        actionId: "onboarding.claim_one",
        slots: {},
        userId: "",
        router,
        appRuntimeState: runtimeState({
          auth: { signed_in: false, user_id: null },
          vault: {
            unlocked: false,
            token_available: false,
            token_valid: false,
          },
          route: { pathname: "/", screen: "one_intro", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(handler).toHaveBeenCalledWith({}, undefined);
      expect(result).toMatchObject({
        status: "started",
        actionId: "onboarding.claim_one",
        resultSummary: "Opening sign-in.",
      });
    } finally {
      unregisterLocalOnboardingHandler("onboarding.claim_one", handler);
    }
  });

  it("waits for a started local mutation after a later voice abort", async () => {
    const router = { push: vi.fn() };
    const controller = new AbortController();
    let finish:
      | ((value: { status: "succeeded"; summary: string }) => void)
      | null = null;
    const handler = vi.fn(
      () =>
        new Promise<{ status: "succeeded"; summary: string }>((resolve) => {
          finish = resolve;
        }),
    );
    registerLocalOnboardingHandler("onboarding.claim_one", handler);

    try {
      const resultPromise = executeAgentGatewayAction({
        actionId: "onboarding.claim_one",
        slots: {},
        signal: controller.signal,
        userId: "",
        router,
        appRuntimeState: runtimeState({
          auth: { signed_in: false, user_id: null },
          vault: {
            unlocked: false,
            token_available: false,
            token_valid: false,
          },
          route: { pathname: "/", screen: "one_intro", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      controller.abort();
      finish?.({ status: "succeeded", summary: "Sign-in opened." });

      await expect(resultPromise).resolves.toMatchObject({
        status: "succeeded",
        actionId: "onboarding.claim_one",
      });
    } finally {
      unregisterLocalOnboardingHandler("onboarding.claim_one", handler);
    }
  });

  it("does not start a local effect when cancelled during handler resolution", async () => {
    const controller = new AbortController();
    const handler = vi.fn().mockResolvedValue({ status: "succeeded", summary: "Opened." });
    registerLocalOnboardingHandler("onboarding.claim_one", handler);
    try {
      const pending = executeAgentGatewayAction({
        actionId: "onboarding.claim_one",
        signal: controller.signal,
        userId: "user_1",
        router: { push: vi.fn() },
        appRuntimeState: runtimeState({ route: { pathname: "/", screen: "one_intro", subview: null } }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });
      controller.abort();
      await expect(pending).resolves.toMatchObject({ status: "failed", reason: "execution_aborted" });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregisterLocalOnboardingHandler("onboarding.claim_one", handler);
    }
  });

  it("does not start a prepared effect after cancellation during revalidation", async () => {
    const controller = new AbortController();
    const handler = vi.fn().mockResolvedValue({ status: "succeeded", summary: "Done." });
    let release!: () => void;
    const binding = { owner: "user_1" };
    const prepare = vi.fn(() => new Promise<{ status: "ready"; binding: typeof binding; summary: string }>((resolve) => {
      release = () => resolve({ status: "ready", binding, summary: "Ready." });
    }));
    const hook = renderHook(() => useLocalOnboardingActionHandler("location.pause_updates", handler, { prepare }));
    try {
      const pending = resolveLocalOnboardingHandler("location.pause_updates")!({}, {
        signal: controller.signal,
        preparedBinding: binding,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      controller.abort();
      release();
      await expect(pending).resolves.toMatchObject({ status: "failed" });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });
});
