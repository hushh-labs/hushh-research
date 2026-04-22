import { describe, expect, it } from "vitest";

import { composeVoiceSpeechAfterExecution } from "@/lib/voice/voice-response-composer";
import type { VoiceActionResult, VoicePlanPayload, VoiceResponse } from "@/lib/voice/voice-types";

function makeExecuteResponse(message: string): VoiceResponse {
  return {
    kind: "execute",
    message,
    speak: true,
    tool_call: {
      tool_name: "execute_kai_command",
      args: {
        command: "profile",
      },
    },
  };
}

function makePlan(
  overrides: Partial<VoicePlanPayload> = {}
): VoicePlanPayload {
  return {
    mode: "execute_and_wait",
    action_id: "nav.profile",
    reply_strategy: "template",
    response: makeExecuteResponse("Opening profile."),
    ...overrides,
  };
}

function makeActionResult(
  overrides: Partial<VoiceActionResult> = {}
): VoiceActionResult {
  return {
    status: "succeeded",
    action_id: "nav.profile",
    route_before: "/kai",
    route_after: "/profile",
    screen_before: "dashboard",
    screen_after: "profile",
    settled_by: "screen",
    result_summary: "Navigated to /profile.",
    ...overrides,
  };
}

describe("composeVoiceSpeechAfterExecution", () => {
  it("uses settled surface metadata for post-navigation screen explanation", () => {
    const speech = composeVoiceSpeechAfterExecution({
      response: makeExecuteResponse("Opening receipts."),
      plan: makePlan({
        action_id: "nav.profile_receipts",
      }),
      actionResult: makeActionResult({
        action_id: "nav.profile_receipts",
        route_after: "/profile/receipts",
        screen_after: "receipts",
        result_summary: "Navigated to /profile/receipts.",
        data: {
          surface_title: "Receipts",
          surface_purpose: "Review Gmail-derived purchases and build PKM memory from them.",
        },
      }),
      plannerFinalText: "Opening receipts.",
    });

    expect(speech).toEqual({
      text: "You're on Receipts now. Review Gmail-derived purchases and build PKM memory from them.",
      segmentType: "final",
    });
  });

  it("turns a profile navigation result into a post-settlement screen explanation", () => {
    const speech = composeVoiceSpeechAfterExecution({
      response: makeExecuteResponse("Opening profile."),
      plan: makePlan(),
      actionResult: makeActionResult({
        result_summary: "Navigated to /profile.",
        data: {
          surface_title: "Profile",
          surface_purpose: "Manage your investor identity, connected data sources, and account controls.",
        },
      }),
      plannerFinalText: "Opening profile.",
    });

    expect(speech).toEqual({
      text: "You're on Profile now. Manage your investor identity, connected data sources, and account controls.",
      segmentType: "final",
    });
  });

  it("treats opened-style navigation summaries as settled destination speech", () => {
    const speech = composeVoiceSpeechAfterExecution({
      response: makeExecuteResponse("Opening profile."),
      plan: makePlan(),
      actionResult: makeActionResult({
        result_summary: "Opened your profile.",
        data: {
          surface_title: "Profile",
          surface_purpose: "Manage your investor identity, connected data sources, and account controls.",
        },
      }),
      plannerFinalText: "Opening profile.",
    });

    expect(speech).toEqual({
      text: "You're on Profile now. Manage your investor identity, connected data sources, and account controls.",
      segmentType: "final",
    });
  });

  it("keeps deterministic background acknowledgements anchored to the real action result", () => {
    const speech = composeVoiceSpeechAfterExecution({
      response: {
        kind: "background_started",
        task: "analysis",
        ticker: "NVDA",
        run_id: "run_1",
        message: "Started analysis for NVDA in background.",
        speak: true,
      },
      plan: {
        mode: "start_background_and_ack",
        action_id: "analysis.start",
        reply_strategy: "template",
        response: {
          kind: "background_started",
          task: "analysis",
          ticker: "NVDA",
          run_id: "run_1",
          message: "Started analysis for NVDA in background.",
          speak: true,
        },
      },
      actionResult: {
        status: "started",
        action_id: "analysis.start",
        route_before: "/kai/dashboard",
        route_after: "/kai/analysis?ticker=NVDA",
        screen_before: "dashboard",
        screen_after: "analysis",
        settled_by: "background_start",
        result_summary: "I've started analyzing NVDA.",
      },
      plannerAckText: "Working on NVDA now.",
    });

    expect(speech).toEqual({
      text: "I've started analyzing NVDA.",
      segmentType: "ack",
    });
  });

  it("prefers the real blocked outcome over optimistic planner text", () => {
    const speech = composeVoiceSpeechAfterExecution({
      response: makeExecuteResponse("Opening Gmail."),
      plan: makePlan({
        action_id: "nav.profile_gmail_panel",
      }),
      actionResult: {
        status: "blocked",
        action_id: "nav.profile_gmail_panel",
        route_before: "/profile",
        route_after: null,
        screen_before: "profile",
        screen_after: null,
        result_summary: "Unlock the vault before using this Kai voice action.",
      },
      plannerFinalText: "Opening Gmail.",
    });

    expect(speech).toEqual({
      text: "Unlock the vault before using this Kai voice action.",
      segmentType: "final",
    });
  });
});
