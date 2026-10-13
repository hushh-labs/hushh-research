"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from "react";

/**
 * Step Progress Context
 *
 * Tracks loading progress based on discrete steps defined by each page.
 * Pages register their total steps on mount and call completeStep() after
 * each async operation completes.
 *
 * Progress = (completedSteps / totalSteps) * 100
 *
 * This provides accurate, predictable progress feedback instead of
 * fake/simulated progress bars.
 */

interface StepProgressContextValue {
  /**
   * Register the total number of steps for the current page.
   * Call this on mount with the number of async operations.
   */
  registerSteps: (total: number) => void;

  /**
   * Mark one step as complete. Call after each async operation finishes.
   */
  completeStep: () => void;

  /**
   * Reset progress to 0. Call on unmount or when starting fresh.
   */
  reset: () => void;

  /**
   * Current progress percentage (0-100).
   */
  progress: number;

  /**
   * True when loading is in progress (progress > 0 and < 100).
   */
  isLoading: boolean;

  /**
   * Start a scoped progress task to avoid cross-route conflicts.
   */
  beginTask: (scope: string, totalSteps: number) => void;

  /**
   * Advance one step for the given scope.
   */
  completeTaskStep: (scope: string) => void;

  /**
   * End/clear a scoped task.
   */
  endTask: (scope: string) => void;
}

const StepProgressContext = createContext<StepProgressContextValue | undefined>(
  undefined
);

interface StepProgressProviderProps {
  children: ReactNode;
}

export function StepProgressProvider({ children }: StepProgressProviderProps) {
  const LEGACY_SCOPE = "__legacy__";
  const [tasks, setTasks] = useState<
    Record<
      string,
      {
        totalSteps: number;
        completedSteps: number;
      }
    >
  >({});

  const beginTask = useCallback((scope: string, totalSteps: number) => {
    if (!scope) return;
    const safeTotal = Math.max(0, Math.floor(totalSteps));
    setTasks((prev) => ({
      ...prev,
      [scope]: {
        totalSteps: safeTotal,
        completedSteps: 0,
      },
    }));
  }, []);

  const completeTaskStep = useCallback((scope: string) => {
    if (!scope) return;
    setTasks((prev) => {
      const current = prev[scope];
      if (!current) return prev;
      const nextCompleted = Math.min(current.totalSteps, current.completedSteps + 1);
      return {
        ...prev,
        [scope]: {
          ...current,
          completedSteps: nextCompleted,
        },
      };
    });
  }, []);

  const endTask = useCallback((scope: string) => {
    if (!scope) return;
    setTasks((prev) => {
      if (!(scope in prev)) return prev;
      const next = { ...prev };
      delete next[scope];
      return next;
    });
  }, []);

  const registerSteps = useCallback(
    (total: number) => {
      beginTask(LEGACY_SCOPE, total);
    },
    [beginTask]
  );

  const completeStep = useCallback(() => {
    completeTaskStep(LEGACY_SCOPE);
  }, [completeTaskStep]);

  const reset = useCallback(() => {
    endTask(LEGACY_SCOPE);
  }, [endTask]);

  const metrics = useMemo(() => {
    const values = Object.values(tasks);
    if (!values.length) {
      return { progress: 0, isLoading: false };
    }

    const total = values.reduce((sum, current) => sum + Math.max(0, current.totalSteps), 0);
    const completed = values.reduce(
      (sum, current) => sum + Math.min(current.totalSteps, Math.max(0, current.completedSteps)),
      0
    );
    if (total <= 0) {
      return { progress: 0, isLoading: false };
    }
    const progress = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
    return {
      progress,
      isLoading: completed < total,
    };
  }, [tasks]);

  return (
    <StepProgressContext.Provider
      value={{
        registerSteps,
        completeStep,
        reset,
        progress: metrics.progress,
        isLoading: metrics.isLoading,
        beginTask,
        completeTaskStep,
        endTask,
      }}
    >
      {children}
    </StepProgressContext.Provider>
  );
}

/**
 * Hook to access step progress context.
 * Returns safe defaults if used outside provider.
 */
export function useStepProgress(): StepProgressContextValue {
  const context = useContext(StepProgressContext);

  if (context === undefined) {
    // Return safe no-op defaults if provider not available
    return {
      registerSteps: () => {},
      completeStep: () => {},
      reset: () => {},
      progress: 0,
      isLoading: false,
      beginTask: () => {},
      completeTaskStep: () => {},
      endTask: () => {},
    };
  }

  return context;
}
