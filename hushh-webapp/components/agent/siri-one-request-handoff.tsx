"use client";

import { useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { oneSystemRequestRuntime, type RequestRuntimeState } from "@/lib/agent/one-system-request-runtime";

/**
 * Thin foreground component that:
 * 1. Subscribes to the stable request runtime
 * 2. Waits for auth/owner readiness
 * 3. Hands off claimed requests to the proposal executor
 *
 * No microphone startup. No model execution inside cleanup.
 * The runtime owns the claim lifecycle; this component only orchestrates.
 */
export function SiriOneRequestHandoff() {
  const { data: session, status } = useSession();
  const ownerId = session?.user?.id ?? null;
  const isReady = status === "authenticated" && Boolean(ownerId);
  const runtimeStartedRef = useRef(false);
  const lastHandoffRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady || runtimeStartedRef.current) return;
    runtimeStartedRef.current = true;

    oneSystemRequestRuntime.setOwner(ownerId);
    const unsub = oneSystemRequestRuntime.startListening();

    return () => {
      unsub();
      runtimeStartedRef.current = false;
    };
  }, [isReady, ownerId]);

  useEffect(() => {
    if (!isReady) return;

    const unsub = oneSystemRequestRuntime.subscribe((state: RequestRuntimeState) => {
      if (state.status !== "claimed") return;

      // Prevent duplicate handoffs for the same invocation
      if (lastHandoffRef.current === state.invocation.id) return;
      lastHandoffRef.current = state.invocation.id;

      handoffToExecutor(state.invocation);
    });

    return unsub;
  }, [isReady]);

  return null; // Invisible component
}

const handoffToExecutor = async (invocation: {
  id: string;
  kind: string;
  source: string;
  createdAt: number;
  expiresAt: number;
  protocolVersion: string;
  ownerBinding: string;
}): Promise<void> => {
  // The proposal executor will handle the rest
  // For now, complete with a placeholder result
  console.log(`[RequestHandoff] Handing off claimed request: ${invocation.id}`);

  // TODO: Wire to actual proposal executor
  await oneSystemRequestRuntime.complete(
    "clarification_required",
    "Request captured. Proposal executor not yet wired.",
  );
};
