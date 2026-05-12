"use client";

import { useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { cn } from "@/lib/utils";

/**
 * Step Progress Bar
 *
 * A thin progress bar at the top of the viewport that shows real progress
 * based on completed loading steps.
 * * Optimized for Antigravity with smooth transitions and safety guards.
 */
export function StepProgressBar() {
  const { progress, isLoading } = useStepProgress();
  const [visible, setVisible] = useState(false);
  const [displayProgress, setDisplayProgress] = useState(0);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Clear any pending timeouts to avoid race conditions during fast state changes
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    if (isLoading) {
      // Immediate show and update
      setVisible(true);
      setDisplayProgress(progress);
    } else if (progress >= 100) {
      // Complete: Ensure bar reaches 100% visually first
      setDisplayProgress(100);

      // Sequence: Wait for fill animation -> Fade out -> Reset value
      hideTimeoutRef.current = setTimeout(() => {
        setVisible(false);

        // Reset progress only AFTER fade-out (300ms) is complete to prevent "jumping"
        hideTimeoutRef.current = setTimeout(() => {
          setDisplayProgress(0);
        }, 300);
      }, 500);
    } else if (progress === 0) {
      // Hard reset
      setVisible(false);
      setDisplayProgress(0);
    }

    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [progress, isLoading]);

  // We keep the component mounted if it's either visible OR the progress hasn't
  // finished resetting. This allows the 300ms CSS fade-out to play.
  if (!visible && displayProgress === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed left-0 right-0 top-0 flex justify-center pointer-events-none transform-gpu",
        "z-[100] transition-opacity duration-300 ease-in-out",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{
        // Resolves the top position using the CSS variable or a default
        top: "var(--top-inset, 0px)"
      }}
    >
      <Progress
        value={displayProgress}
        className="h-1 w-full rounded-none bg-transparent"
      />
    </div>
  );
}