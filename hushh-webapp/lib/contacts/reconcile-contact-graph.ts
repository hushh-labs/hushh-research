/** Ensure a mutation refresh cannot join a read started before the mutation. */
export async function reconcileContactGraph(options: {
  pendingRead: Promise<unknown> | null;
  isCurrent: () => boolean;
  invalidate: () => void;
  read: () => Promise<unknown>;
}): Promise<void> {
  await options.pendingRead?.catch(() => undefined);
  if (!options.isCurrent()) return;
  options.invalidate();
  await options.read();
}

/** Retries share one read; a new mutation must run a read after that work. */
export function createContactGraphReconciler() {
  let pending: { owner: string; task: Promise<void> } | null = null;
  return (
    owner: string,
    options: Parameters<typeof reconcileContactGraph>[0],
    fresh = false,
  ) => {
    if (pending?.owner === owner && !fresh) return pending.task;
    const previous = pending?.task;
    const task = (async () => {
      await previous?.catch(() => undefined);
      await reconcileContactGraph(options);
    })().finally(() => {
      if (pending?.task === task) pending = null;
    });
    pending = { owner, task };
    return task;
  };
}
