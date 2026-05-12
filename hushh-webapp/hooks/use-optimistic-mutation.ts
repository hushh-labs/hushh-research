"use client";

import { useCallback, useState } from "react";

type OptimisticMutationConfig = {
  apply: () => void;
  rollback: () => void;
  commit: () => Promise<void>;
};

export function useOptimisticMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const runOptimisticMutation = useCallback(
    async ({ apply, rollback, commit }: OptimisticMutationConfig) => {
      setPending(true);
      setError(null);

      apply();

      try {
        await commit();
      } catch (nextError) {
        rollback();
        setError(nextError);
        throw nextError;
      } finally {
        setPending(false);
      }
    },
    []
  );

  const resetOptimisticMutation = useCallback(() => {
    setPending(false);
    setError(null);
  }, []);

  return {
    pending,
    error,
    runOptimisticMutation,
    resetOptimisticMutation,
  };
}