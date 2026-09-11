import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(process.cwd(), "components/agent/agent-bar.tsx"),
  "utf8",
);
const LOCATION_COMMAND_BRIDGE_SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "components/one-location/onboarding/location-command-device-bridge.tsx",
  ),
  "utf8",
);
const LOCATION_INTERACTION_SURFACE_SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "components/one-location/onboarding/location-onboarding-interaction-surface.tsx",
  ),
  "utf8",
);
const LOCATION_COMMAND_STATUS_CARD_SOURCE = readFileSync(
  resolve(process.cwd(), "lib/one-location/location-command-status-card.ts"),
  "utf8",
);

describe("AgentBar Gemini Live voice routing", () => {
  it("keeps legacy textual handoffs bounded and sends no local intent proposal", () => {
    const nativeTurnStart = SOURCE.indexOf('if (event.source === "input")');
    const nativeTurnEnd = SOURCE.indexOf(
      'if (event.type === "tool_trace")',
      nativeTurnStart,
    );
    const nativeTurn = SOURCE.slice(nativeTurnStart, nativeTurnEnd);

    expect(nativeTurnStart).toBeGreaterThan(-1);
    expect(nativeTurn).toContain("transport?.sendUserText?.(transcript);");
    expect(nativeTurn).toContain('metric: "voice_turn_delegated_to_agent"');
    expect(nativeTurn).not.toContain("resolveLocalIntent");
    expect(SOURCE).toContain("client.sendUserText?.(initialRequestText);");
    expect(SOURCE).not.toContain("prepareLocalIntentResolver");
  });

  it("uses direct native PCM rather than Apple or Fluid transcript recognition", () => {
    expect(SOURCE).toContain("createOneVoiceRealtimeAudioInput()");
    expect(SOURCE).toContain("realtimeAudioInput,");
    expect(SOURCE).not.toContain("createOneVoiceSpeechAdapter");
    expect(SOURCE).toContain("Gemini Live produced this display transcript");
  });

  it("keeps hard-card actions outside spoken and journey confirmation paths", () => {
    expect(SOURCE).toContain("requiresTrustedTapConfirmation");
    expect(SOURCE).toContain('confirmationMethod: "journey_grant"');
    expect(SOURCE).toContain('confirmationMethod !== "tap"');
    expect(SOURCE).toContain('setVoiceStatus("thinking", "Tap to confirm"');
  });

  it("keeps a pending confirmation through ordinary route changes", () => {
    // The interaction surface is mounted at app root. A route is merely a
    // context update; it must not settle or cancel a server-issued card.
    expect(SOURCE).toContain(
      "This card is owned by the app-root interaction host",
    );
    expect(SOURCE).not.toContain('"route_changed"');
    expect(SOURCE).not.toContain("pending.route");
    expect(SOURCE).not.toContain("route: pathname");
    expect(SOURCE).toContain("path === ROUTES.AGENT && !pendingConfirmation");
    expect(SOURCE).toContain("agentWindowActive && !pendingConfirmation");
    // Explicit security/lifecycle boundaries remain cancellation paths.
    expect(SOURCE).toContain('"superseded_by_new_directive"');
    expect(SOURCE).toContain('"session_closed"');
    expect(SOURCE).toContain('"session_cancelled"');
    expect(SOURCE).toContain('"component_unmounted"');
  });

  it("does not create a foreground welcome or warm conversation", () => {
    expect(SOURCE).toContain("appInteractionCoordinator.subscribeLifecycle");
    expect(SOURCE).toContain(
      "Talk-to-One is a command surface, not a foreground live-chat surface.",
    );
    expect(SOURCE).not.toContain('activationSource: "foreground_warm"');
    expect(SOURCE).not.toContain("initialGreetingEnabled: true");
    expect(SOURCE).not.toContain("reserveGreeting(");
    expect(SOURCE).not.toContain("markGreetingDelivered");
    expect(SOURCE).not.toContain("releaseGreeting(");
    expect(SOURCE).not.toContain("freshSessionGreetingLifecycleByUser");
    expect(SOURCE).not.toContain("reserveFreshSessionGreeting");
    expect(SOURCE).not.toContain("markFreshSessionGreetingDelivered");
    expect(SOURCE).not.toContain("releaseFreshSessionGreeting");
    expect(SOURCE).toContain("initialGreetingEnabled: false");
  });

  it("uses only a server-minted opaque scope for greeting and follow-up timing", () => {
    expect(SOURCE).toContain("ApiService.getOneAdkLiveRelaySession");
    expect(SOURCE).toContain(
      "voiceSessionScopeRef.current = voiceSessionScope",
    );
    expect(SOURCE).toContain("oneVoiceSessionLifecycle.openFollowUpWindow");
    expect(SOURCE).toContain("oneVoiceSessionLifecycle.extendFollowUpOnSpeech");
    expect(SOURCE).toContain("oneVoiceSessionLifecycle.closeFollowUpWindow");
    // AgentBar holds only an in-memory capture timer and must not directly
    // write a uid or route/transcript data to browser storage.
    expect(SOURCE).not.toContain("recordMeaningfulActivity");
    expect(SOURCE).not.toMatch(/(?:window\.)?localStorage\./);
  });

  it("starts the greeting follow-up only after trusted output settles", () => {
    const greeting = SOURCE.indexOf('event.type === "greeting"');
    const playbackSettled = SOURCE.indexOf(
      'event.type === "greeting_playback_settled"',
      greeting,
    );
    const armAfterPlayback = SOURCE.indexOf(
      "armServerGreetingFollowUp({",
      playbackSettled,
    );

    expect(greeting).toBeGreaterThan(-1);
    expect(playbackSettled).toBeGreaterThan(greeting);
    expect(armAfterPlayback).toBeGreaterThan(playbackSettled);
    expect(SOURCE).toContain("Tap to enable microphone for replies.");
    expect(SOURCE).toContain("canAutoArmGreetingFollowUp");
  });

  it("closes only cloud capture when the 10-second follow-up expires", () => {
    const followUpStart = SOURCE.indexOf(
      "const scheduleFollowUpCaptureClose = useCallback",
    );
    const followUpEnd = SOURCE.indexOf(
      "const scheduleVoiceIdleTimer = useCallback",
      followUpStart,
    );
    const followUp = SOURCE.slice(followUpStart, followUpEnd);

    expect(followUpStart).toBeGreaterThan(-1);
    expect(followUpEnd).toBeGreaterThan(followUpStart);
    expect(followUp).toContain(
      "oneVoiceSessionLifecycle.closeFollowUpWindow(scope)",
    );
    expect(followUp).toContain("transport.stopAudioInput()");
    expect(followUp).toContain('setVoiceStatus("idle", "Tap to talk")');
    expect(followUp).not.toContain("stopConversation()");
    expect(SOURCE).toContain(
      "scheduleFollowUpCaptureClose(voiceSessionScope, followUpWindow)",
    );
    expect(SOURCE).toContain(
      "scheduleFollowUpCaptureClose(voiceSessionScope, extendedFollowUp)",
    );
    // The relay remains available behind a visible tap-ready pill; it is not
    // represented as a still-listening active-call control.
    expect(SOURCE).toContain('conversationActive && voiceStatus !== "idle"');
  });

  it("does not let reconnects or an old auth owner refresh the greeting gate", () => {
    expect(SOURCE).toContain(
      'activationSource: OneVoiceActivationSource = "recovery"',
    );
    expect(SOURCE).toContain('startConversation(undefined, "tap")');
    expect(SOURCE).toContain('"siri_app_shortcut" : "action_button"');
    expect(SOURCE).toContain(
      "ownerEpoch !== voiceSessionOwnerEpochRef.current",
    );
    expect(SOURCE).toContain("relaySessionAbortControllerRef");
  });

  it("leaves a visible, accessible tap-to-start state after the welcome", () => {
    expect(SOURCE).toContain("foregroundGreetingReady");
    expect(SOURCE).toContain('data-testid="one-voice-talk-ready"');
    expect(SOURCE).toContain(
      "Tap to talk to One. I’ll listen until you finish.",
    );
    expect(SOURCE).toContain("const beginLocationCommandTap");
    expect(SOURCE).toContain("const handleVoiceStartClick");
    expect(SOURCE).toContain("onClick={handleVoiceStartClick}");
    expect(SOURCE).not.toContain("handleVoicePointerDown");
    expect(SOURCE).not.toContain("onLostPointerCapture");
    expect(SOURCE).not.toContain("handleVoiceKeyDown");
  });

  it("always selects transcript-first command mode before tap input", () => {
    // The Talk control never downgrades to the conversational relay. The
    // server remains authoritative for admission, and an unavailable command
    // lane is a typed command failure rather than a chat fallback.
    expect(SOURCE).toContain('activationSource === "tap" || activationSource === "action_button"');
    expect(SOURCE).toContain("ensureLocationCommandActivation()");
    expect(SOURCE).not.toContain("if (!locationCommandRuntimeEnabled) {");
    expect(SOURCE).toContain("beginLocationCommandTap();");
    // The dedicated branch enters command mode unconditionally after it has
    // established that this is an opaque command turn. It must not inherit a
    // broader conversation flag or downgrade to the old relay after capture.
    expect(SOURCE).toContain("if (locationCommandTurnId) {");
    expect(SOURCE).toContain("locationCommandMode: true,");
    expect(SOURCE).toContain("locationCommandMode: Boolean(locationCommandTurnId),");
    expect(SOURCE).toContain(
      "A client may never\n      // silently downgrade its PCM to the conversational relay",
    );
  });

  it("keeps command taps out of every warm conversational session", () => {
    const commandStart = SOURCE.indexOf(
      "const startConversation = useCallback",
    );
    const commandSession = SOURCE.slice(
      commandStart,
      SOURCE.indexOf(
        "const runtimeConnection = await resolveGeminiRuntimeConnection",
        commandStart,
      ),
    );

    expect(commandSession).toContain("if (locationCommandTurnId) {");
    expect(commandSession).toContain("stopPrewarmedSession();");
    expect(SOURCE).toContain(
      "Talk-to-One is a command surface, not a foreground live-chat surface.",
    );
    expect(SOURCE).toContain(
      "Location commands use the managed secure voice service.",
    );
  });

  it("opens local command capture before managed runtime and relay-ticket awaits", () => {
    const start = SOURCE.indexOf("const startConversation = useCallback");
    const commandColdStart = SOURCE.indexOf(
      "const relaySessionPromise = ApiService.getOneAdkLiveRelaySession",
      start,
    );
    const commandTurnClaim = SOURCE.indexOf(
      "if (!client.beginInputTurn?.({ turnId: locationCommandTurnId }))",
      commandColdStart,
    );
    const commandCaptureStart = SOURCE.indexOf(
      "const startPromise = client.start({",
      commandColdStart,
    );
    const runtimeResolution = SOURCE.indexOf(
      "const runtimeConnection = await resolveGeminiRuntimeConnection",
      start,
    );

    expect(commandColdStart).toBeGreaterThan(start);
    expect(commandColdStart).toBeLessThan(runtimeResolution);
    expect(commandTurnClaim).toBeGreaterThan(commandColdStart);
    expect(commandTurnClaim).toBeLessThan(commandCaptureStart);
    expect(SOURCE).toContain(
      "const realtimeAudioInput = createOneVoiceRealtimeAudioInput();",
    );
    expect(SOURCE).toContain(
      "relayUrlPromise: relaySessionPromise.then(({ relayUrl }) => relayUrl)",
    );
    expect(SOURCE).toContain("locationCommandMode: true,");
  });

  it("binds each action execution and destination settlement to its own abort signal", () => {
    const localSignals = SOURCE.match(/signal: actionSignal/g) ?? [];

    expect(SOURCE).toContain("const actionController = new AbortController()");
    expect(SOURCE).toContain("const isCurrentDirectiveRun = () =>");
    expect(SOURCE).toContain("const currentDirectiveExecution = () =>");
    expect(SOURCE).toContain("const isCurrentPendingExecution = () =>");
    expect(localSignals).toHaveLength(4);
    expect(SOURCE).not.toContain("signal: actionAbortControllerRef.current");
  });

  it("does not announce a navigation success before destination context settles", () => {
    const settlementCalls = SOURCE.match(
      /settleAgentBarActionWithDestination\(/g,
    );

    expect(SOURCE).toContain("DESTINATION_CONTEXT_UNSETTLED_SUMMARY");
    expect(SOURCE).toContain("function failedDestinationContextResult");
    expect(SOURCE).toContain('status: "failed"');
    expect(SOURCE).not.toContain("function pendingDestinationContextResult");
    expect(SOURCE).toContain("destination_context_unsettled");
    expect(SOURCE).toContain("destination_context_unacknowledged");
    // Direct directives and confirmation-card actions share the same barrier.
    expect(settlementCalls?.length).toBeGreaterThanOrEqual(3);
    expect(SOURCE).not.toContain(".then(settleAgentBarAction)");
  });

  it("renders only endpointed typed Location command results through approved cards or compiled routes", () => {
    const resultStart = SOURCE.indexOf(
      'if (event.type === "location_command_result")',
    );
    const resultEnd = SOURCE.indexOf(
      'if (event.type === "state")',
      resultStart,
    );
    const resultBranch = SOURCE.slice(resultStart, resultEnd);

    expect(resultStart).toBeGreaterThan(-1);
    expect(resultEnd).toBeGreaterThan(resultStart);
    // A result must still match the same opaque tap after relay-owned speech
    // end. Stale, cancelled, incomplete, or non-endpointed turns cannot
    // touch UI.
    expect(resultBranch).toContain(
      "activeLocationCommand?.turnId !== event.turnId",
    );
    expect(resultBranch).toContain("activeLocationCommand.cancelled");
    expect(resultBranch).toContain("activeLocationCommand.completed");
    expect(resultBranch).toContain("!activeLocationCommand.endpointed");
    expect(SOURCE).toContain(
      'if (event.type === "location_command_endpointed")',
    );
    expect(SOURCE).toContain(
      'setVoiceStatus("thinking", "Transcribing", eventOptions)',
    );

    // A durable workflow result is handed to the app-root command bridge. It
    // owns real permission/GPS interactions and never makes the legacy setup
    // page authoritative for the server run.
    expect(resultBranch).toContain(
      "isLocationCommandWorkflowDirective(event.result)",
    );
    expect(resultBranch).toContain(
      "surface.presentServerResult(workflowResult)",
    );
    // The Circle-name card has its own durable run and lease. AgentBar may
    // request its presentation, but app-root owns the state, recovery and
    // rendering so a route-specific bar cannot discard it.
    expect(resultBranch).toContain("presentCircleNameDirective(");
    expect(resultBranch).toContain("event.circleNameDirective");
    expect(SOURCE).not.toContain("<LocationCircleNameInputCard");
    expect(LOCATION_INTERACTION_SURFACE_SOURCE).toContain(
      "function OneLocationCircleNameInteractionHost",
    );
    expect(LOCATION_INTERACTION_SURFACE_SOURCE).toContain(
      "fetchActiveLocationCircleNameDirective(vaultOwnerToken)",
    );
    expect(LOCATION_INTERACTION_SURFACE_SOURCE).toContain(
      "parseLocationCircleNameDirective(candidate)",
    );
    expect(resultBranch).not.toContain("stageServerResultForRoute");
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "OneLocationOnboardingDeviceOrchestrator",
    );
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "OneLocationService.requestLocationPermission()",
    );
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "OneLocationService.captureCurrentPosition({ fresh: true })",
    );
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "openPlaceForm: async () => openLocationSetup()",
    );
    expect(SOURCE).toContain(
      "directive.lease.runRevision === result.run.revision",
    );
    expect(SOURCE).toContain(
      "pendingDirective.lease.runRevision === result.run.revision",
    );
    expect(resultBranch).toContain(
      "publishLocationCommandStatusCard(event.statusCard)",
    );
    expect(resultBranch).not.toContain("client_directive");

    // A place is never written through the command bridge's legacy client
    // path. The real Location form is a truthful, unverified navigation
    // fallback until its receipt/finalizer is bound to this durable run.
    expect(resultBranch).not.toContain("stageLocationCommandPlaceContinuation");
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "savePlace: async () => false",
    );
    expect(LOCATION_COMMAND_BRIDGE_SOURCE).toContain(
      "legacy setup coordinator from claiming a command run completed",
    );

    // Navigation is selected by the server graph but still checked against
    // the registered client action target. No arbitrary/model route can win.
    expect(resultBranch).toContain(
      "getKaiActionById(event.navigation.capabilityId)",
    );
    expect(resultBranch).toContain("target.target === event.navigation.route");
    expect(resultBranch).toContain("requestInternalAppNavigation({");
    expect(resultBranch).toContain("router.push(event.navigation.route");

    // Verified execution cards carry only fixed ids; the UI owns all copy.
    expect(LOCATION_COMMAND_STATUS_CARD_SOURCE).toContain(
      "one.location.command.circle_verified.v1",
    );
    expect(LOCATION_COMMAND_STATUS_CARD_SOURCE).toContain(
      'actionId: "location.create_circle"',
    );
    expect(LOCATION_COMMAND_STATUS_CARD_SOURCE).toContain(
      "one.location.command.location_verified.v1",
    );
    expect(LOCATION_COMMAND_STATUS_CARD_SOURCE).toContain(
      'actionId: "workflow.setup.location"',
    );
  });
});
