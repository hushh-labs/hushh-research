"use client";

import { useEffect, useRef, useState } from "react";

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

interface UseSmoothStreamProgressOptions {
  stiffness?: number;
  minDelta?: number;
  resetHint?: boolean;
}

/**
 * Smoothly animates stream progress while keeping monotonic semantics.
 * Progress never decreases, and always respects backend-provided floor.
 */
export function useSmoothStreamProgress(
  targetProgress: number,
  options: UseSmoothStreamProgressOptions = {}
): number {
  const stiffness = options.stiffness ?? 0.18;
  const minDelta = options.minDelta ?? 0.35;
  const resetHint = options.resetHint ?? false;

  const [displayProgress, setDisplayProgress] = useState(() =>
    clampProgress(targetProgress)
  );
  const rafRef = useRef<number | null>(null);
  const displayedRef = useRef(displayProgress);

  useEffect(() => {
    displayedRef.current = displayProgress;
  }, [displayProgress]);

  useEffect(() => {
    const target = clampProgress(targetProgress);
    if (resetHint) {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      displayedRef.current = target;
      setDisplayProgress(target);
      return;
    }
    // New run guard: if a new stream starts near 0, reset the visual floor
    // instead of staying pinned to the previous run's terminal progress.
    if (target <= 10 && displayedRef.current - target >= 20) {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      displayedRef.current = target;
      setDisplayProgress(target);
      return;
    }
    const floor = Math.max(displayedRef.current, target);

    if (floor <= displayedRef.current + 0.01) {
      return;
    }

    const animate = () => {
      const current = displayedRef.current;
      if (current >= floor - 0.01) {
        setDisplayProgress(floor);
        displayedRef.current = floor;
        rafRef.current = null;
        return;
      }

      const delta = Math.max(minDelta, (floor - current) * stiffness);
      const next = Math.min(floor, current + delta);
      displayedRef.current = next;
      setDisplayProgress(next);
      rafRef.current = window.requestAnimationFrame(animate);
    };

    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    rafRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [targetProgress, stiffness, minDelta, resetHint]);

  return displayProgress;
}
