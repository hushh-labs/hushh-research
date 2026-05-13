export type AtomicAgentTask<TValue = unknown> = {
  id: string;
  critical?: boolean;
  run: () => Promise<TValue>;
};

export type AtomicAgentTaskResult<TValue = unknown> = {
  id: string;
  critical: boolean;
  status: "fulfilled" | "rejected";
  value?: TValue;
  errorMessage?: string;
};

export type AtomicAgentExecutionResult<TValue = unknown> = {
  ok: boolean;
  failedCriticalTaskCount: number;
  results: AtomicAgentTaskResult<TValue>[];
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runAtomicAgentTasks<TValue = unknown>(
  tasks: AtomicAgentTask<TValue>[]
): Promise<AtomicAgentExecutionResult<TValue>> {
  const settledResults = await Promise.allSettled(
    tasks.map(async (task) => ({
      task,
      value: await task.run(),
    }))
  );

  const results = settledResults.map(
    (result, index): AtomicAgentTaskResult<TValue> => {
      const task = tasks[index];

if (!task) {
  return {
    id: `unknown-${index}`,
    critical: false,
    status: "rejected",
    errorMessage: "Atomic agent task metadata was missing.",
  };
}

      if (result.status === "fulfilled") {
        return {
          id: task.id,
          critical: Boolean(task.critical),
          status: "fulfilled",
          value: result.value.value,
        };
      }

      return {
        id: task.id,
        critical: Boolean(task.critical),
        status: "rejected",
        errorMessage: getErrorMessage(result.reason),
      };
    }
  );

  const failedCriticalTaskCount = results.filter(
    (result) => result.critical && result.status === "rejected"
  ).length;

  return {
    ok: failedCriticalTaskCount === 0,
    failedCriticalTaskCount,
    results,
  };
}