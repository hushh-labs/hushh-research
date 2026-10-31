/**
 * The seam between React's Profiler and the render-performance probe.
 *
 * `RenderPerfProfiler` (components/app-ui) wraps the shell in a `<Profiler>`
 * and forwards every commit here. With the probe off the sink is null and
 * the forward is a null check; in a production build React never calls
 * `onRender` at all (only `next build --profile` aliases react-dom to its
 * profiling build), so the wrapper costs nothing where it is not wanted.
 * The probe installs a sink while it runs and clears it when it stops.
 */

export type RenderCommitPhase = "mount" | "update" | "nested-update";

export type RenderCommit = {
  phase: RenderCommitPhase;
  /** Time React spent rendering this commit's changed subtree. */
  actual_ms: number;
  /** React's estimate of the whole subtree without memoisation. */
  base_ms: number;
  /** `performance.now()` when the commit was committed. */
  at_ms: number;
};

type RenderCommitSink = (commit: RenderCommit) => void;

let sink: RenderCommitSink | null = null;

export function setRenderCommitSink(next: RenderCommitSink | null): void {
  sink = next;
}

export function reportRenderCommit(
  phase: RenderCommitPhase,
  actualDuration: number,
  baseDuration: number,
  commitTime: number,
): void {
  if (!sink) return;
  sink({ phase, actual_ms: actualDuration, base_ms: baseDuration, at_ms: commitTime });
}

/** For tests: whether a sink is installed. */
export function hasRenderCommitSink(): boolean {
  return sink !== null;
}
