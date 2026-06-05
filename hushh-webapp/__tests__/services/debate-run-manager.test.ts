import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getActiveKaiDebateRun: vi.fn(),
  startKaiDebateRun: vi.fn(),
  streamKaiDebateRun: vi.fn(),
  consumeCanonicalKaiStream: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getActiveKaiDebateRun: (...args: unknown[]) =>
      apiMocks.getActiveKaiDebateRun(...args),
    startKaiDebateRun: (...args: unknown[]) => apiMocks.startKaiDebateRun(...args),
    streamKaiDebateRun: (...args: unknown[]) => apiMocks.streamKaiDebateRun(...args),
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
    apiMocks.startKaiDebateRun.mockReset();
    apiMocks.streamKaiDebateRun.mockReset();
    apiMocks.consumeCanonicalKaiStream.mockReset();
    apiMocks.streamKaiDebateRun.mockResolvedValue(response(200));
    apiMocks.consumeCanonicalKaiStream.mockResolvedValue(undefined);
  });

  it("recovers stale local running locks when backend has no active debate", async () => {
    const manager = await loadManager([persistedTask("stale-run")]);
    apiMocks.getActiveKaiDebateRun.mockResolvedValueOnce(response(404));
    apiMocks.startKaiDebateRun.mockResolvedValueOnce(
      response(200, { run: runPayload("fresh-run") }),
    );

    const result = await manager.ensureRun(ensureParams);

    expect(result.kind).toBe("started");
    expect(apiMocks.getActiveKaiDebateRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.startKaiDebateRun).toHaveBeenCalledTimes(1);
    expect(manager.getTask("stale-run")?.status).toBe("failed");
    expect(manager.getTask("fresh-run")?.status).toBe("running");
  });

  it("blocks on a verified backend active debate without starting a second run", async () => {
    const manager = await loadManager([persistedTask("local-run")]);
    apiMocks.getActiveKaiDebateRun.mockResolvedValueOnce(
      response(200, { run: runPayload("server-run") }),
    );

    const result = await manager.ensureRun({
      ...ensureParams,
      ticker: "MSFT",
      pickSource: "search",
    });

    expect(result.kind).toBe("blocked");
    expect(result.task.runId).toBe("server-run");
    expect(result.task.pickSource).toBe("search");
    expect(apiMocks.startKaiDebateRun).not.toHaveBeenCalled();
  });
});
