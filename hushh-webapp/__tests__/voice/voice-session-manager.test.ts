import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createKaiRealtimeSessionMock = vi.fn();
const connectMock = vi.fn();
const closeMock = vi.fn();

let clientConnected = false;

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    createKaiRealtimeSession: (...args: unknown[]) => createKaiRealtimeSessionMock(...args),
  },
}));

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: () => "vturn_test",
}));

vi.mock("@/lib/voice/voice-realtime-client", () => ({
  VoiceRealtimeClient: class {
    connect(...args: unknown[]) {
      return connectMock(...args);
    }

    close(...args: unknown[]) {
      return closeMock(...args);
    }

    connected() {
      return clientConnected;
    }

    commitInputAudio() {}

    requestSpeech() {
      return Promise.resolve();
    }

    cancelSpeech() {}
  },
}));

function createFakeStream(): MediaStream {
  const tracks = [
    {
      enabled: true,
      stop: vi.fn(),
    },
  ];
  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("voice-session-manager visibility flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    createKaiRealtimeSessionMock.mockReset();
    connectMock.mockReset();
    closeMock.mockReset();
    clientConnected = false;

    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(createFakeStream()),
      },
    });

    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
      set: (value) => {
        hidden = Boolean(value);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not tear down an in-flight connect on a transient hidden event", async () => {
    createKaiRealtimeSessionMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        client_secret: "secret",
        model: "gpt-realtime",
        voice: "alloy",
        session_id: "sess_1",
      }),
    });

    let resolveConnect: (() => void) | null = null;
    connectMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = () => {
            clientConnected = true;
            resolve();
          };
        })
    );

    const { voiceSessionManager } = await import("@/lib/voice/voice-session-manager");
    const reasons: string[] = [];
    const unsubscribe = voiceSessionManager.subscribe((event) => {
      if (event.type === "connection") {
        reasons.push(event.reason);
      }
    });

    const acquireResult = voiceSessionManager
      .acquire({
        scopeId: "scope_1",
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        activate: true,
      })
      .then(() => null)
      .catch((error) => error);

    await flushMicrotasks();

    (document as Document & { hidden: boolean }).hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(200);

    (document as Document & { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(500);

    expect(closeMock).not.toHaveBeenCalled();
    expect(reasons).not.toContain("app_background");

    resolveConnect?.();
    expect(await acquireResult).toBeNull();

    expect(voiceSessionManager.getSnapshot().state).toBe("connected");
    unsubscribe();
    await voiceSessionManager.release("scope_1");
  });

  it("disconnects after a real background and resumes on foreground when active", async () => {
    createKaiRealtimeSessionMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        client_secret: "secret",
        model: "gpt-realtime",
        voice: "alloy",
        session_id: `sess_${createKaiRealtimeSessionMock.mock.calls.length}`,
      }),
    }));

    connectMock.mockImplementation(async () => {
      clientConnected = true;
      return createFakeStream();
    });
    closeMock.mockImplementation(async () => {
      clientConnected = false;
    });

    const { voiceSessionManager } = await import("@/lib/voice/voice-session-manager");
    const reasons: string[] = [];
    const unsubscribe = voiceSessionManager.subscribe((event) => {
      if (event.type === "connection") {
        reasons.push(event.reason);
      }
    });

    await voiceSessionManager.acquire({
      scopeId: "scope_1",
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      activate: true,
    });

    expect(voiceSessionManager.getSnapshot().state).toBe("connected");
    expect(createKaiRealtimeSessionMock).toHaveBeenCalledTimes(1);

    (document as Document & { hidden: boolean }).hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5200);
    await flushMicrotasks();

    expect(closeMock).toHaveBeenCalled();
    expect(voiceSessionManager.getSnapshot().state).toBe("idle");
    expect(reasons).toContain("app_background");

    (document as Document & { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();

    await vi.waitFor(() => {
      expect(createKaiRealtimeSessionMock).toHaveBeenCalledTimes(2);
      expect(voiceSessionManager.getSnapshot().state).toBe("connected");
    });
    expect(reasons).toContain("foreground_resume");

    unsubscribe();
    await voiceSessionManager.release("scope_1");
  });

  it("refreshes the vault owner token from the live provider before reconnecting", async () => {
    const tokenState = { current: "vault_token_initial" };
    createKaiRealtimeSessionMock.mockImplementation(async (input: { vaultOwnerToken: string }) => ({
      ok: true,
      json: async () => ({
        client_secret: `secret_${input.vaultOwnerToken}`,
        model: "gpt-realtime",
        voice: "alloy",
        session_id: `sess_${createKaiRealtimeSessionMock.mock.calls.length}`,
      }),
    }));
    connectMock.mockImplementation(async () => {
      clientConnected = true;
    });
    closeMock.mockImplementation(async () => {
      clientConnected = false;
    });

    const { voiceSessionManager } = await import("@/lib/voice/voice-session-manager");

    await voiceSessionManager.acquire({
      scopeId: "scope_1",
      userId: "user_1",
      vaultOwnerToken: tokenState.current,
      getVaultOwnerToken: () => tokenState.current,
      activate: true,
    });

    tokenState.current = "vault_token_refreshed";
    (document as Document & { hidden: boolean }).hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5200);
    await flushMicrotasks();

    (document as Document & { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(createKaiRealtimeSessionMock).toHaveBeenCalledTimes(2);
      expect(voiceSessionManager.getSnapshot().state).toBe("connected");
    });
    expect(createKaiRealtimeSessionMock.mock.calls[1]?.[0]).toMatchObject({
      vaultOwnerToken: "vault_token_refreshed",
    });

    await voiceSessionManager.release("scope_1");
  });

  it("resumes after a real background interrupts the initial connect", async () => {
    createKaiRealtimeSessionMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        client_secret: "secret",
        model: "gpt-realtime",
        voice: "alloy",
        session_id: `sess_${createKaiRealtimeSessionMock.mock.calls.length}`,
      }),
    }));

    let resolveFirstConnect: (() => void) | null = null;
    connectMock
      .mockImplementationOnce(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("VOICE_SESSION_CONNECT_ABORTED"));
              return;
            }
            const abortListener = () => reject(new Error("VOICE_SESSION_CONNECT_ABORTED"));
            signal?.addEventListener("abort", abortListener, { once: true });
            resolveFirstConnect = () => {
              signal?.removeEventListener("abort", abortListener);
              clientConnected = true;
              resolve();
            };
          })
      )
      .mockImplementationOnce(async () => {
        clientConnected = true;
      });
    closeMock.mockImplementation(async () => {
      clientConnected = false;
    });

    const { voiceSessionManager } = await import("@/lib/voice/voice-session-manager");

    const acquireResult = voiceSessionManager
      .acquire({
        scopeId: "scope_1",
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        activate: true,
      })
      .then(() => null)
      .catch((error) => error);

    await flushMicrotasks();

    (document as Document & { hidden: boolean }).hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5200);
    await flushMicrotasks();

    const acquireError = await acquireResult;
    expect(acquireError).toBeInstanceOf(Error);
    expect((acquireError as Error).message).toBe("VOICE_SESSION_CONNECT_ABORTED");
    expect(voiceSessionManager.getSnapshot().state).toBe("idle");

    (document as Document & { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(createKaiRealtimeSessionMock).toHaveBeenCalledTimes(2);
      expect(voiceSessionManager.getSnapshot().state).toBe("connected");
    });

    resolveFirstConnect?.();
    await voiceSessionManager.release("scope_1");
  });
});
