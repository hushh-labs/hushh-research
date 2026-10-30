"use client";

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

import { reportRenderCommit } from "@/lib/perf/render-commit-sink";

/**
 * Wraps the app shell in a React Profiler whose only job is to hand each
 * commit to the render-performance probe (lib/perf/render-commit-sink.ts).
 *
 * Inert by construction: in a production build React never invokes
 * `onRender` (only `next build --profile`, the attribution build, aliases
 * react-dom to its profiling variant), and even there the callback is a null
 * check while the probe is off. It renders no element and holds no state, so
 * it never causes a re-render of its own.
 */
const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
  reportRenderCommit(phase, actualDuration, baseDuration, commitTime);
};

export function RenderPerfProfiler({ children }: { children: ReactNode }) {
  return (
    <Profiler id="app" onRender={onRender}>
      {children}
    </Profiler>
  );
}
