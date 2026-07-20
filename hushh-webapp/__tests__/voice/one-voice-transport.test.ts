import { describe, expect, it, vi } from "vitest";

import { GeminiLiveTransport } from "@/lib/services/gemini-live-client";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";

describe("One Voice realtime transports", () => {
  it("exposes Gemini Live as the active provider-neutral transport", () => {
    const transport = new GeminiLiveTransport();

    expect(transport.provider).toBe("gemini_live");
    expect(typeof transport.start).toBe("function");
    expect(typeof transport.stop).toBe("function");
  });

  it("creates transports through the provider-neutral factory", () => {
    expect(createRealtimeVoiceTransport().provider).toBe("gemini_live");
  });

  it("sends the runtime bootstrap before any app context and drops the BYOK key", () => {
    const send = vi.fn();
    const socket: { send: typeof send; onopen: (() => void) | null } = {
      send,
      onopen: null,
    };
    class WebSocketMock {
      constructor(_url: string) {
        return socket;
      }
    }
    vi.stubGlobal("WebSocket", WebSocketMock);

    const transport = new GeminiLiveTransport();
    const testTransport = transport as unknown as {
      runtimeCredentialMode: "hushh_managed_vertex" | "byok";
      runtimeCredential: string | null;
      connectSocket: (relayUrl: string) => void;
    };
    testTransport.runtimeCredentialMode = "byok";
    testTransport.runtimeCredential = "test-key";
    testTransport.connectSocket("wss://relay.example.test/live");
    socket.onopen?.();

    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      type: "runtime_bootstrap",
      runtime_credential_mode: "byok",
      runtime_credential_transport: "developer_api",
      runtime_credential: "test-key",
    });
    expect(testTransport.runtimeCredential).toBeNull();
    vi.unstubAllGlobals();
  });

  it("emits Gemini state events with session and source sequence metadata", () => {
    const onEvent = vi.fn();
    const onVoiceState = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent, onVoiceState });
    const testTransport = transport as unknown as {
      sessionId: string | null;
      setState: (state: "connecting") => void;
    };

    testTransport.sessionId = "gemini_session_1";
    testTransport.setState("connecting");

    expect(onVoiceState).toHaveBeenCalledWith("connecting", {
      sessionId: "gemini_session_1",
      sourceId: "gemini_live",
      sourceSeq: 1,
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state",
        provider: "gemini_live",
        sessionId: "gemini_session_1",
        sourceId: "gemini_live",
        sourceSeq: 1,
      })
    );
  });

  it("normalizes ADK relay transcripts and client directives", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent });
    const testTransport = transport as unknown as {
      sessionId: string | null;
      handleSocketMessage: (data: string) => Promise<void>;
    };

    testTransport.sessionId = "gemini_session_1";
    await testTransport.handleSocketMessage(
      JSON.stringify({
        inputTranscription: {
          text: "show my portfolio",
          confidence: 0.9,
        },
        outputTranscription: {
          text: "I can help with that.",
        },
      })
    );
    await testTransport.handleSocketMessage(
      JSON.stringify({
        clientDirective: {
          kind: "navigate",
          payload: { route: "/one/kai", screen: "finance" },
        },
      })
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "transcript_final",
        text: "show my portfolio",
        provider: "gemini_live",
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant_text",
        text: "I can help with that.",
        provider: "gemini_live",
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "client_directive",
        provider: "gemini_live",
        directive: {
          kind: "navigate",
          payload: { route: "/one/kai", screen: "finance" },
        },
      })
    );
  });

  it("returns a correlated browser action settlement to the ADK relay", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    expect(
      transport.reportActionSettlement({
        directiveId: "directive-1",
        actionId: "analysis.start",
        status: "blocked",
        summary: "Portfolio access is locked.",
        reason: "vault_locked",
      })
    ).toBe(true);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: "action_settled",
      actionSettlement: {
        directiveId: "directive-1",
        actionId: "analysis.start",
        status: "blocked",
        summary: "Portfolio access is locked.",
        reason: "vault_locked",
      },
    });
  });

  it("acknowledges destination context before a settled journey may report", async () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      handleSocketMessage: (data: string) => Promise<void>;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;
    const destination = {
      snapshot_id: "ctx-login-2",
      route: { screen: "login", route_family: "/login", playbook_id: "route.login" },
      revisions: { route: 2, ui: 2 },
      auth: { signed_in: false },
      persona: { active: "default" },
      voice: { state: "listening" },
      available_action_ids: ["auth.sign_in_google", "auth.sign_in_apple"],
      ui: { visible_modules: [], visible_control_ids: [] },
      pending_settlement: false,
      cache: { freshness: "fresh", vault_ready: false, portfolio_ready: false },
      onboarding: { phase: "anonymous_auth" },
    };

    const waiting = transport.applyContextAndWait?.(destination as never, { timeoutMs: 50 });
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      type: "app_context",
      contextId: "ctx-login-2:settled",
    });
    await testTransport.handleSocketMessage(
      JSON.stringify({ appContextAccepted: { contextId: "ctx-login-2:settled" } }),
    );

    await expect(waiting).resolves.toEqual({
      status: "acknowledged",
      contextId: "ctx-login-2:settled",
    });
  });

  it("does not accept the first spoken turn until the initial route context is acknowledged", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent });
    const send = vi.fn();
    const initialContext = {
      snapshot_id: "ctx-intro-1",
      route: { screen: "one_intro", route_family: "/", playbook_id: "route.home" },
      revisions: { route: 1, ui: 1 },
      auth: { signed_in: false },
      persona: { active: "investor" },
      voice: { state: "idle" },
      available_action_ids: ["onboarding.claim_one"],
      ui: { visible_modules: [], visible_control_ids: [] },
      pending_settlement: false,
      cache: { freshness: "fresh_or_stale_safe", vault_ready: false, portfolio_ready: false },
      onboarding: { phase: "anonymous_auth" },
    };
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      startContext: typeof initialContext;
      setupComplete: boolean;
      initialContextReady: boolean;
      handleSocketMessage: (data: string) => Promise<void>;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.startContext = initialContext;

    await testTransport.handleSocketMessage(JSON.stringify({ setupComplete: {} }));

    expect(testTransport.setupComplete).toBe(true);
    expect(testTransport.initialContextReady).toBe(false);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "listening" }),
    );
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "app_context",
      contextId: "ctx-intro-1:settled",
      appContext: { available_action_ids: ["onboarding.claim_one"] },
    });

    await testTransport.handleSocketMessage(
      JSON.stringify({ appContextAccepted: { contextId: "ctx-intro-1:settled" } }),
    );
    await Promise.resolve();

    expect(testTransport.initialContextReady).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "listening" }),
    );
  });

  it("emits one transcript-free visitor activity frame after sustained speech", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    for (let index = 0; index < 7; index += 1) {
      expect(testTransport.sendVisitorActivityStart(0.09, new Uint8Array([index]))).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();

    expect(testTransport.sendVisitorActivityStart(0.09, new Uint8Array([7]))).toBe(false);
    expect(testTransport.sendVisitorActivityStart(0.5, new Uint8Array([8]))).toBe(true);

    expect(send).toHaveBeenCalledTimes(9);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: "voice_activity_start" });
    expect(JSON.parse(send.mock.calls[1][0])).toMatchObject({
      realtimeInput: { audio: { data: expect.any(String) } },
    });
  });

  it("does not treat low microphone energy as visitor activity", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    for (let index = 0; index < 20; index += 1) {
      testTransport.sendVisitorActivityStart(0.01, new Uint8Array([index]));
    }

    expect(send).not.toHaveBeenCalled();
  });

});
