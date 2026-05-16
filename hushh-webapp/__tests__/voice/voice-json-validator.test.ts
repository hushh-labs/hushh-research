import { describe, expect, it } from "vitest";

import {
  normalizeClarifyToolCall,
  validateVoicePlanPayload,
  validateVoiceResponse,
  validateVoiceToolCall,
} from "@/lib/voice/voice-json-validator";

describe("voice-json-validator", () => {
  it("validates execute tool calls and normalizes ticker", () => {
    const toolCall = validateVoiceToolCall({
      tool_name: "execute_kai_command",
      args: {
        command: "analyze",
        params: {
          symbol: "nvda",
        },
      },
    });

    expect(toolCall).toEqual({
      tool_name: "execute_kai_command",
      args: {
        command: "analyze",
        params: {
          symbol: "NVDA",
        },
      },
    });
  });

  it("rejects analysis command alias coercion even when symbol is present", () => {
    const toolCall = validateVoiceToolCall({
      tool_name: "execute_kai_command",
      args: {
        command: "analysis",
        params: {
          symbol: "googl",
        },
      },
    });

    expect(toolCall).toBeNull();
  });

  it("accepts import command payloads", () => {
    const toolCall = validateVoiceToolCall({
      tool_name: "execute_kai_command",
      args: {
        command: "import",
      },
    });

    expect(toolCall).toEqual({
      tool_name: "execute_kai_command",
      args: {
        command: "import",
      },
    });
  });

  it("validates blocked response payload", () => {
    const response = validateVoiceResponse({
      kind: "blocked",
      reason: "vault_required",
      message: "Unlock your vault to use voice.",
      speak: true,
    });

    expect(response).toEqual({
      kind: "blocked",
      reason: "vault_required",
      message: "Unlock your vault to use voice.",
      speak: true,
    });
  });

  it("accepts blocked responses for portfolio-required analysis guards", () => {
    const response = validateVoiceResponse({
      kind: "blocked",
      reason: "portfolio_required",
      message: "Import your portfolio before starting stock analysis.",
      speak: true,
    });

    expect(response).toEqual({
      kind: "blocked",
      reason: "portfolio_required",
      message: "Import your portfolio before starting stock analysis.",
      speak: true,
    });
  });

  it("validates plan payload with memory hints", () => {
    const payload = validateVoicePlanPayload({
      schema_version: "kai.voice.plan.v1",
      mode: "execute_and_wait",
      action_id: "analysis.start",
      slots: {
        ticker: "NVDA",
        confirmation_required: false,
        context: {
          source: "voice",
        },
      },
      guards: ["portfolio_required", "analysis_idle_required"],
      reply_strategy: "template",
      response: {
        kind: "execute",
        message: "Starting analysis for NVDA.",
        speak: true,
        tool_call: {
          tool_name: "execute_kai_command",
          args: {
            command: "analyze",
            params: {
              symbol: "NVDA",
            },
          },
        },
      },
      memory: {
        allow_durable_write: true,
      },
    });

    expect(payload).toEqual({
      schema_version: "kai.voice.plan.v1",
      mode: "execute_and_wait",
      action_id: "analysis.start",
      slots: {
        ticker: "NVDA",
        confirmation_required: false,
        context: {
          source: "voice",
        },
      },
      guards: ["portfolio_required", "analysis_idle_required"],
      reply_strategy: "template",
      response: {
        kind: "execute",
        message: "Starting analysis for NVDA.",
        speak: true,
        tool_call: {
          tool_name: "execute_kai_command",
          args: {
            command: "analyze",
            params: {
              symbol: "NVDA",
            },
          },
        },
      },
      memory: {
        allow_durable_write: true,
      },
    });
  });

  it("preserves legacy-only payload compatibility when canonical fields are absent", () => {
    const payload = validateVoicePlanPayload({
      response: {
        kind: "speak_only",
        message: "Opening profile.",
        speak: true,
      },
    });

    expect(payload).toEqual({
      response: {
        kind: "speak_only",
        message: "Opening profile.",
        speak: true,
      },
    });
  });

  it("validates clarify-mode canonical metadata when provided", () => {
    const payload = validateVoicePlanPayload({
      schema_version: "kai.voice.plan.v1",
      mode: "clarify",
      reply_strategy: "llm",
      clarification: {
        question: "Which ticker did you want?",
        reason: "ticker_ambiguous",
        options: ["NVDA", "NVDL"],
        candidate: "NVDA",
        entity: "ticker",
      },
      response: {
        kind: "clarify",
        reason: "ticker_ambiguous",
        message: "Which ticker did you want?",
        speak: true,
        candidate: "NVDA",
      },
    });

    expect(payload?.clarification).toEqual({
      question: "Which ticker did you want?",
      reason: "ticker_ambiguous",
      options: ["NVDA", "NVDL"],
      candidate: "NVDA",
      entity: "ticker",
    });
  });

  it("rejects malformed response payloads", () => {
    const payload = validateVoicePlanPayload({
      response: {
        kind: "execute",
        message: "bad payload",
        speak: true,
        tool_call: {
          tool_name: "execute_kai_command",
          args: {
            command: "delete_account",
          },
        },
      },
    });

    expect(payload).toBeNull();
  });

  it("rejects canonical execution modes that omit action_id", () => {
    const payload = validateVoicePlanPayload({
      schema_version: "kai.voice.plan.v1",
      mode: "execute_and_wait",
      response: {
        kind: "speak_only",
        message: "Opening profile.",
        speak: true,
      },
    });

    expect(payload).toBeNull();
  });

  it("normalizes clarify helper contract", () => {
    expect(normalizeClarifyToolCall("Say ticker", ["AAPL", "MSFT"])).toEqual({
      tool_name: "clarify",
      args: {
        question: "Say ticker",
        options: ["AAPL", "MSFT"],
      },
    });
  });
});
