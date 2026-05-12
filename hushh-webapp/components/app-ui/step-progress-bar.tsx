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
 *
 * Now uses the shadcn Progress component for consistency.
 */
export function StepProgressBar() {
  const { progress, isLoading } = useStepProgress();
  const [visible, setVisible] = useState(false);
  const [displayProgress, setDisplayProgress] = useState(0);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Clear any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    if (isLoading) {
      // Show bar and update progress
      setVisible(true);
      setDisplayProgress(progress);
    } else if (progress >= 100) {
      // Complete: show 100% then hide after animation
      setDisplayProgress(100);
      hideTimeoutRef.current = setTimeout(() => {
        setVisible(false);
        setDisplayProgress(0);
      }, 500); // Slightly longer to ensure animation finishes
    } else if (progress === 0) {
      // Reset state
      setVisible(false);
      setDisplayProgress(0);
    }

    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [progress, isLoading]);

  // Don't render if not visible
  if (!visible && displayProgress === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed left-0 right-0 z-100 top-[var(--top-inset,0px)] flex justify-center pointer-events-none transform-gpu transition-[top] duration-200"
      )}
      style={{
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease-in-out",
      }}
    >
      <Progress value={displayProgress} className="h-1 rounded-none bg-transparent" />
    </div>
  );
}
