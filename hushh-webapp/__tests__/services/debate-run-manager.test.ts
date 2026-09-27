import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getActiveKaiDebateRun: vi.fn(),
  startKaiDebateRunStream: vi.fn(),
  streamKaiDebateRun: vi.fn(),
  cancelKaiDebateRun: vi.fn(),
  consumeCanonicalKaiStream: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getActiveKaiDebateRun: (...args: unknown[]) =>
      apiMocks.getActiveKaiDebateRun(...args),
    startKaiDebateRunStream: (...args: unknown[]) =>
      apiMocks.startKaiDebateRunStream(...args),
    streamKaiDebateRun: (...args: unknown[]) => apiMocks.streamKaiDebateRun(...args),
    cancelKaiDebateRun: (...args: unknown[]) => apiMocks.cancelKaiDebateRun(...args),
  },
}));

vi.mock("@/lib/streaming/kai-stream-client", () => ({
  consumeCanonicalKaiStream: (...args: unknown[]) =>
    apiMocks.consumeCanonicalKaiStream(...args),
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    hasRunningTask: vi.fn(() => false),
  },
}));

vi.mock("@/lib/services/kai-history-service", () => ({
  KaiHistoryService: {
    saveAnalysis: vi.fn(async () => true),
  },
}));

const STORAGE_KEY = "kai_debate_run_manager_v1";
const SESSION_KEY = "kai_debate_session_id_v1";
const SESSION_ID = "debate_session_test";

function response(status: number, payload?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  };
}

function runPayload(runId: string, userId = "user-1", ticker = "AAPL") {
  return {
    run_id: runId,
    user_id: userId,
    debate_session_id: SESSION_ID,
    ticker,
    status: "running",
    started_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    latest_cursor: 0,
  };
}

function persistedTask(runId: string, userId = "user-1") {
  return {
    runId,
    userId,
    debateSessionId: SESSION_ID,
    ticker: "AAPL",
    status: "running",
    startedAt: "2026-05-27T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-05-27T00:00:00.000Z",
    latestCursor: 0,
    persistenceState: "none",
    persistenceError: null,
    dismissedAt: null,
    finalDecision: null,
  };
}

async function loadManager(tasks: unknown[]) {
  window.sessionStorage.clear();
  window.sessionStorage.setItem(SESSION_KEY, SESSION_ID);
  window.sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      debateSessionId: SESSION_ID,
      tasks,
    }),
  );
  vi.resetModules();
  const mod = await import("@/lib/services/debate-run-manager");
  return mod.DebateRunManagerService;
}

// The backend stamps the run id into every envelope of the stream that
// started the run; the first one is how the client learns which run it owns.
function announceRun(runId: string) {
  return async (...args: unknown[]) => {
    const emit = args[1] as (envelope: Record<string, unknown>) => void;
    emit({
      schema_version: "1.0",
      stream_id: `run_${runId}`,
      stream_kind: "stock_analyze",
      seq: 1,
      event: "start",
      terminal: false,
      payload: { run_id: runId },
    });
  };
}

const ensureParams = {
  userId: "user-1",
  ticker: "AAPL",
  riskProfile: "balanced",
  vaultOwnerToken: "vault-token",
  vaultKey: "vault-key",
};

describe("DebateRunManagerService start gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getActiveKaiDebateRun.mockReset();
    apiMocks.startKaiDebateRunStream.mockReset();
    apiMocks.streamKaiDebateRun.mockReset();
    apiMocks.cancelKaiDebateRun.mockReset();
    apiMocks.consumeCanonicalKaiStream.mockReset();
    apiMocks.streamKaiDebateRun.mockResolvedValue(response(200));
    apiMocks.consumeCanonicalKaiStream.mockResolvedValue(undefined);
  });

  it("recovers stale local running locks when backend has no active debate", async () => {
    const manager = await loadManager([persistedTask("stale-run")]);
    apiMocks.getActiveKaiDebateRun.mockResolvedValueOnce(response(404));
    apiMocks.startKaiDebateRunStream.mockResolvedValueOnce(response(200));
    apiMocks.consumeCanonicalKaiStream.mockImplementationOnce(
      announceRun("fresh-run"),
    );

    const result = await manager.ensureRun(ensureParams);

    expect(result.kind).toBe("started");
    expect(apiMocks.getActiveKaiDebateRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.startKaiDebateRunStream).toHaveBeenCalledTimes(1);
    expect(manager.getTask("stale-run")?.status).toBe("failed");
    expect(manager.getTask("fresh-run")?.status).toBe("running");
  });

  // UAT 2026-09-26/27: every debate started, then its separate GET .../stream
  // reached a backend process that never held the run and got 404. A new run
  // must be streamed by the request that starts it, never by a second request.
  it("starts and attaches a new run in one request", async () => {
    const manager = await loadManager([]);
    apiMocks.startKaiDebateRunStream.mockResolvedValueOnce(response(200));
    apiMocks.consumeCanonicalKaiStream.mockImplementationOnce(
      announceRun("fresh-run"),
    );

    const result = await manager.ensureRun({ ...ensureParams, pickSource: "default" });

    expect(result.task.runId).toBe("fresh-run");
    expect(apiMocks.startKaiDebateRunStream.mock.calls[0]?.[0]).toMatchObject({
      debateSessionId: SESSION_ID,
      ticker: "AAPL",
      pickSource: "default",
    });
    expect(apiMocks.streamKaiDebateRun).not.toHaveBeenCalled();
  });

  it("blocks on a verified backend active debate without starting a second run", async () => {
    const manager = await loadManager([persistedTask("local-run")]);
    apiMocks.getActiveKaiDebateRun.mockResolvedValueOnce(
      response(200, {
        run: {
          ...runPayload("server-run"),
          pick_source: "ria:advisor-1:package-2",
          pick_source_label: "Advisor picks",
          pick_source_kind: "ria",
        },
      }),
    );

    const result = await manager.ensureRun({
      ...ensureParams,
      ticker: "MSFT",
      pickSource: "search",
    });

    expect(result.kind).toBe("blocked");
    expect(result.task.runId).toBe("server-run");
    // The active run retains its server-authorized source snapshot. A new
    // browser selection must never relabel a run that is already in progress.
    expect(result.task.pickSource).toBe("ria:advisor-1:package-2");
    expect(result.task.pickSourceLabel).toBe("Advisor picks");
    expect(result.task.pickSourceKind).toBe("ria");
    expect(apiMocks.startKaiDebateRunStream).not.toHaveBeenCalled();
  });

  it("coalesces identical in-flight starts for the same debate session", async () => {
    const manager = await loadManager([]);
    let resolveStart!: (value: ReturnType<typeof response>) => void;
    apiMocks.startKaiDebateRunStream.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    apiMocks.consumeCanonicalKaiStream.mockImplementationOnce(
      announceRun("fresh-run"),
    );

    const first = manager.ensureRun({
      ...ensureParams,
      pickSource: "default",
    });
    const second = manager.ensureRun({
      ...ensureParams,
      pickSource: "default",
    });

    await Promise.resolve();
    expect(apiMocks.startKaiDebateRunStream).toHaveBeenCalledTimes(1);

    resolveStart(response(200));
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.kind)).toEqual(["started", "started"]);
    expect(results[0]?.task.runId).toBe("fresh-run");
    expect(results[1]?.task.runId).toBe("fresh-run");
    expect(apiMocks.streamKaiDebateRun).not.toHaveBeenCalled();
  });

  it("settles a cancelled run locally even when the backend cannot reach it", async () => {
    const manager = await loadManager([persistedTask("live-run")]);
    apiMocks.cancelKaiDebateRun.mockResolvedValueOnce(response(404));

    await expect(
      manager.cancelRun({
        runId: "live-run",
        userId: "user-1",
        vaultOwnerToken: "vault-token",
      }),
    ).rejects.toThrow("HTTP 404");

    // Previously the failed request threw first and left the task "running",
    // so the analysis page kept (or re-derived) a live debate after Cancel.
    expect(manager.getTask("live-run")?.status).toBe("canceled");
    expect(manager.getActiveTaskForUser("user-1")).toBeNull();
  });

  it("keeps a run active and resumes from its last cursor after a transport interruption", async () => {
    vi.useFakeTimers();
    try {
      const manager = await loadManager([]);
      apiMocks.getActiveKaiDebateRun.mockResolvedValueOnce(
        response(200, { run: runPayload("resume-run") }),
      );
      apiMocks.consumeCanonicalKaiStream
        .mockImplementationOnce(async (...args: unknown[]) => {
          const emit = args[1] as (envelope: Record<string, unknown>) => void;
          emit({
            schema_version: "1.0",
            stream_id: "run_resume-run",
            stream_kind: "stock_analyze",
            seq: 1,
            event: "kai_thinking",
            terminal: false,
            payload: {},
          });
          throw new Error("Network connection lost");
        })
        .mockResolvedValueOnce(undefined);

      const resumed = manager.resumeActiveRun({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        vaultKey: "vault-key",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await resumed;

      expect(manager.getTask("resume-run")?.status).toBe("running");
      expect(manager.getTask("resume-run")?.streamState).toBe("connected");
      expect(apiMocks.streamKaiDebateRun).toHaveBeenCalledTimes(2);
      expect(apiMocks.streamKaiDebateRun.mock.calls[1]?.[0]).toMatchObject({
        runId: "resume-run",
        resumeCursor: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
