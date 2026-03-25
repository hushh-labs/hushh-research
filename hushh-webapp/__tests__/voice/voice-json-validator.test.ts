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

  it("validates plan payload with memory hints", () => {
    const payload = validateVoicePlanPayload({
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
