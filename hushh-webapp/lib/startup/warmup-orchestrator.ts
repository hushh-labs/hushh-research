type WarmupTaskStatus = "fulfilled" | "rejected" | "timed-out";

type WarmupTask = {
  id: string;
  critical?: boolean;
  timeoutMs?: number;
  run: () => Promise<void> | void;
};

type WarmupTaskResult = {
  id: string;
  critical: boolean;
  status: WarmupTaskStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  errorMessage?: string;
};

type WarmupOrchestratorResult = {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  taskCount: number;
  failedCriticalTaskCount: number;
  results: WarmupTaskResult[];
};

const DEFAULT_WARMUP_TIMEOUT_MS = 10_000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runWithTimeout(task: WarmupTask) {
  const timeoutMs = task.timeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;

  return Promise.race([
    Promise.resolve(task.run()).then(() => ({
      status: "fulfilled" as const,
    })),
    new Promise<{ status: "timed-out"; errorMessage: string }>((resolve) => {
      setTimeout(() => {
        resolve({
          status: "timed-out",
          errorMessage: `Warmup task timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }),
  ]);
}

export async function runWarmupOrchestrator(
  tasks: WarmupTask[]
): Promise<WarmupOrchestratorResult> {
  const startedAt = Date.now();

  const results = await Promise.all(
    tasks.map(async (task): Promise<WarmupTaskResult> => {
      const taskStartedAt = Date.now();

      try {
        const result = await runWithTimeout(task);
        const completedAt = Date.now();

        return {
          id: task.id,
          critical: Boolean(task.critical),
          status: result.status,
          startedAt: taskStartedAt,
          completedAt,
          durationMs: completedAt - taskStartedAt,
          errorMessage: "errorMessage" in result ? result.errorMessage : undefined,
        };
      } catch (error) {
        const completedAt = Date.now();

        return {
          id: task.id,
          critical: Boolean(task.critical),
          status: "rejected",
          startedAt: taskStartedAt,
          completedAt,
          durationMs: completedAt - taskStartedAt,
          errorMessage: getErrorMessage(error),
        };
      }
    })
  );

  const completedAt = Date.now();

  return {
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    taskCount: tasks.length,
    failedCriticalTaskCount: results.filter(
      (result) => result.critical && result.status !== "fulfilled"
    ).length,
    results,
  };
}

export function createWarmupTask(task: WarmupTask): WarmupTask {
  return task;
}