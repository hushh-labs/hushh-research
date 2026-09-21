/**
 * One clock for every periodic task the app runs while a screen is at rest.
 *
 * Measured on the phone (bug log B41): ten independent `setInterval`s each
 * woke the page on their own phase (three 45 s feed pollers, 30 s and 5 min
 * consent reconciles, the location map's 5 s, 15 s and 30 s timers, a 60 s
 * Puppy poll, 30 s clock ticks), and every wake that started a fetch or set
 * state inside a frame cost a 90 to 150 ms frame. Here every task's next
 * run is aligned to its interval, all due tasks run in one wake, the wake
 * happens after an animation frame and a macrotask (never inside a frame's
 * script phase), and nothing runs while the document is hidden; coming
 * back (visible, focus, online) runs what became due while it was away.
 * A task with interval N runs at multiples of N on the wall clock, so every
 * task sharing an interval shares a wake, and 5 s, 30 s and 45 s tasks
 * coincide whenever their multiples do.
 *
 * `run` may return a promise; a task never overlaps itself. Register with a
 * stable `id`: a second registration with the same id replaces the first.
 */

export type PeriodicTask = {
  id: string;
  intervalMs: number;
  run: () => void | Promise<void>;
  /** Run once at registration (after the frame boundary) as well as on the cadence. */
  immediate?: boolean;
};

type TaskState = PeriodicTask & { nextAt: number; running: boolean };

const MIN_ALIGN_MS = 1_000;
const tasks = new Map<string, TaskState>();
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function hasDocument(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function visible(): boolean {
  return !hasDocument() || document.visibilityState === "visible";
}

function alignedAfter(at: number, intervalMs: number): number {
  const step = Math.max(MIN_ALIGN_MS, intervalMs);
  return Math.ceil(at / step) * step;
}

function afterFrame(callback: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(callback, 0));
}

function runTask(task: TaskState, now: number): void {
  task.nextAt = alignedAfter(now + 1, task.intervalMs);
  let result: void | Promise<void>;
  try {
    result = task.run();
  } catch {
    return;
  }
  // Only a promise-returning task is "running" past this call; a synchronous
  // one is done here (and a microtask must not be needed to say so).
  if (result && typeof (result as Promise<void>).then === "function") {
    task.running = true;
    (result as Promise<void>)
      .catch(() => undefined)
      .finally(() => {
        task.running = false;
      });
  }
}

function wake(): void {
  timer = null;
  if (!visible()) return;
  const now = Date.now();
  const due = [...tasks.values()].filter((task) => !task.running && task.nextAt <= now + 50);
  if (due.length === 0) {
    schedule();
    return;
  }
  afterFrame(() => {
    const at = Date.now();
    for (const task of due) {
      if (tasks.get(task.id) !== task) continue; // unregistered while we waited
      runTask(task, at);
    }
    schedule();
  });
}

function schedule(): void {
  if (timer !== null || tasks.size === 0) return;
  let next = Number.POSITIVE_INFINITY;
  for (const task of tasks.values()) next = Math.min(next, task.nextAt);
  const delay = Math.max(0, next - Date.now());
  timer = setTimeout(wake, delay);
}

function onResume(): void {
  if (!visible()) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  wake();
}

function listen(): void {
  if (listening || !hasDocument()) return;
  listening = true;
  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("online", onResume);
}

export function registerPeriodicTask(task: PeriodicTask): () => void {
  listen();
  const now = Date.now();
  const state: TaskState = {
    ...task,
    nextAt: task.immediate ? now : alignedAfter(now + 1, task.intervalMs),
    running: false,
  };
  tasks.set(task.id, state);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (task.immediate) wake();
  else schedule();
  return () => {
    if (tasks.get(task.id) === state) tasks.delete(task.id);
    if (tasks.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * A caller that ran the task's work itself (on focus, on an event) tells the
 * clock so the next scheduled run is a full interval away, not a repeat a
 * moment later.
 */
export function markPeriodicTaskRan(id: string): void {
  const task = tasks.get(id);
  if (!task) return;
  task.nextAt = alignedAfter(Date.now() + 1, task.intervalMs);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  schedule();
}

/** Test seam: drop every task and timer. */
export function resetIdleSchedulerForTests(): void {
  tasks.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Test seam: the registered task ids. */
export function idleSchedulerTaskIds(): string[] {
  return [...tasks.keys()];
}
