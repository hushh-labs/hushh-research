"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export type IndicatorSpringConfig = {
  stiffness: number;
  damping: number;
  mass?: number;
  /** |velocity| below which the spring is considered at rest. */
  restSpeed?: number;
  /** |value - target| below which the spring is considered at rest. */
  restDelta?: number;
};

export type IndicatorSpringRetargetOptions = {
  /** Snap straight to the value with zero velocity -- no animation frame. */
  instant?: boolean;
};

// Near-critical damping (zeta ~= 1): fast, decisive settle with no visible
// bounce-back, matching "snappy but natural, not bouncy" tab-indicator feel.
export const TAB_INDICATOR_SPRING: IndicatorSpringConfig = {
  stiffness: 520,
  damping: 46,
  mass: 1,
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Dependency-free, hardware-accelerated spring driver for a single numeric
 * value (e.g. an active-tab index). Unlike a CSS transition -- which has a
 * fixed duration and no notion of velocity -- this tracks real velocity, so
 * re-targeting mid-flight (rapid tab taps) blends smoothly from wherever the
 * indicator currently is instead of restarting from rest. That is what makes
 * rapid back-and-forth tapping look continuous instead of janky.
 *
 * `onFrame` fires on every animation frame with the current value; callers
 * must write it straight to a DOM style (transform / CSS custom property),
 * never to React state, so a settling spring never triggers a re-render.
 *
 * Returns a stable `retarget(value, options?)` function. Call it whenever
 * the destination changes (tap, keyboard select, route resync). Pass
 * `{ instant: true }` for the very first paint and for drag frames, where
 * the caller (not the spring) already owns 1:1 tracking.
 */
export function useIndicatorSpring(
  onFrame: (value: number, settled: boolean) => void,
  config: IndicatorSpringConfig = TAB_INDICATOR_SPRING,
): (value: number, options?: IndicatorSpringRetargetOptions) => void {
  const valueRef = useRef<number | null>(null);
  const velocityRef = useRef(0);
  const targetRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  const onFrameRef = useRef(onFrame);
  const configRef = useRef(config);

  // Keep the "latest" refs in sync outside of render (never assign to a ref
  // during render -- concurrent rendering can discard/retry a render pass,
  // and this project's lint enforces that). Runs after every render; both
  // inputs are cheap to compare and virtually never change in practice
  // (`config` is normally the module-level constant below).
  useLayoutEffect(() => {
    onFrameRef.current = onFrame;
    configRef.current = config;
  });

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lastTimeRef.current = null;
  }, []);

  // Defined once via useRef's lazy-initializer argument (never reassigned
  // afterward) rather than a `tickRef.current = ...` statement in the render
  // body, per the same rule. It closes over `tickRef` itself to recurse --
  // by the time this function actually runs (async, on a later frame),
  // `tickRef` is already fully assigned -- and reads the always-fresh
  // `onFrameRef` / `configRef` above, so it never goes stale despite being
  // created only once.
  const tickRef = useRef<(time: number) => void>((time: number) => {
    const target = targetRef.current;
    if (target === null || valueRef.current === null) {
      frameRef.current = null;
      return;
    }
    const { stiffness, damping, mass = 1, restSpeed = 0.004, restDelta = 0.0015 } =
      configRef.current;

    const last = lastTimeRef.current ?? time;
    // Clamp dt so a background tab or a long GC pause can't fling the spring
    // past its target in one giant step.
    const dt = Math.min(Math.max(time - last, 0) / 1000, 1 / 30);
    lastTimeRef.current = time;

    const displacement = valueRef.current - target;
    const acceleration =
      (-stiffness * displacement - damping * velocityRef.current) / mass;
    velocityRef.current += acceleration * dt;
    valueRef.current += velocityRef.current * dt;

    const settled =
      Math.abs(valueRef.current - target) < restDelta &&
      Math.abs(velocityRef.current) < restSpeed;

    if (settled) {
      valueRef.current = target;
      velocityRef.current = 0;
      frameRef.current = null;
      lastTimeRef.current = null;
      onFrameRef.current(target, true);
      return;
    }

    onFrameRef.current(valueRef.current, false);
    frameRef.current = requestAnimationFrame((t) => tickRef.current(t));
  });

  const retarget = useCallback(
    (value: number, options?: IndicatorSpringRetargetOptions) => {
      targetRef.current = value;
      const instant = options?.instant || prefersReducedMotion();

      if (instant) {
        stop();
        valueRef.current = value;
        velocityRef.current = 0;
        onFrameRef.current(value, true);
        return;
      }

      if (valueRef.current === null) {
        valueRef.current = value;
      }
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame((t) => tickRef.current(t));
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return retarget;
}
