"use client";

import { useCallback, useEffect, useRef } from "react";

type AbortableRequestRunner<T> = (signal: AbortSignal) => Promise<T>;

export function useAbortableRequest() {
  const controllerRef = useRef<AbortController | null>(null);

  const abortCurrentRequest = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const runAbortableRequest = useCallback(
    async <T,>(runner: AbortableRequestRunner<T>): Promise<T> => {
      abortCurrentRequest();

      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        return await runner(controller.signal);
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    },
    [abortCurrentRequest]
  );

  useEffect(() => {
    return () => {
      abortCurrentRequest();
    };
  }, [abortCurrentRequest]);

  return {
    abortCurrentRequest,
    runAbortableRequest,
  };
}