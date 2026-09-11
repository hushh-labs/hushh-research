"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { ApiService } from "@/lib/services/api-service";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

type Review = {
  connection_id: string;
  authorization_id: number;
  generation: number;
  client_name: string;
  memory_access: boolean;
};

export function ConsumerMemoryApproval({ connectionId, authorizationId }: {
  connectionId: string; authorizationId: string;
}) {
  const { user, loading } = useAuth();
  const [review, setReview] = useState<(Review & { owner: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const current = review?.owner === user?.uid && review?.connection_id === connectionId
    && String(review.authorization_id) === authorizationId ? review : null;
  const valid = /^cmc_[a-f0-9]{32}$/.test(connectionId) && /^[1-9][0-9]*$/.test(authorizationId)
    && Number.isSafeInteger(Number(authorizationId));
  const path = `/api/oauth/consumer-connections/${encodeURIComponent(connectionId)}`;

  useLayoutEffect(() => {
    setReview(null); setError(null); setBusy(false);
    if (!user || !valid) return;
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || owner.userId !== user.uid) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner);
    async function load() {
      try {
        const token = await user!.getIdToken();
        if (!isCurrent()) return;
        const response = await ApiService.apiFetch(`${path}?authorization_id=${authorizationId}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
        if (!isCurrent()) return;
        const result = await response.json();
        if (!isCurrent()) return;
        if (!response.ok || result.connection_id !== connectionId
          || result.authorization_id !== Number(authorizationId)
          || !Number.isSafeInteger(result.generation) || result.generation < 1
          || typeof result.client_name !== "string" || !result.client_name
          || typeof result.memory_access !== "boolean") throw new Error("unavailable");
        setReview({ ...result, owner: owner!.userId });
      } catch {
        if (isCurrent()) setError("This request is unavailable. Return to your assistant and reconnect.");
      }
    }
    void load();
    return () => controller.abort();
  }, [user, valid, connectionId, authorizationId, path]);

  async function approve() {
    if (!user || !current || busy || current.memory_access) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const controller = controllerRef.current;
    if (!owner || owner.userId !== user.uid || !controller) return;
    const isCurrent = () => !controller.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner);
    if (!isCurrent()) return;
    setBusy(true); setError(null);
    try {
      const token = await user.getIdToken();
      if (!isCurrent()) return;
      const response = await ApiService.apiFetch(`${path}/approve`, {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generation: current.generation, authorization_id: current.authorization_id,
          policy_version: 1, personal_memory_until_disconnected: true }),
      });
      if (!isCurrent()) return;
      const result = await response.json();
      if (!isCurrent()) return;
      if (!response.ok || result.memory_access !== true || typeof result.grant_receipt !== "string")
        throw new Error("unavailable");
      setReview({ ...current, memory_access: true });
    } catch {
      if (isCurrent()) setError("Permission was not confirmed. Return to your assistant to check or retry.");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const returnPath = `/oauth/authorize?consumer=${encodeURIComponent(connectionId)}&authorization=${encodeURIComponent(authorizationId)}`;
  return <main className="mx-auto flex min-h-dvh max-w-lg items-start px-6 pt-[12vh]">
    <section className="w-full space-y-5">
      <p className="text-sm font-medium text-primary">Hussh · Personal memory</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {current ? `Memory for ${current.client_name}` : "Connect your memory"}
      </h1>
      {loading ? <p>Checking sign-in…</p> : !user ? <>
        <p>Sign in to review this assistant’s access.</p>
        <Button asChild><Link href={`/login?redirect=${encodeURIComponent(returnPath)}`}>Sign in to continue</Link></Button>
      </> : !valid ? <p role="alert">This connection link is invalid.</p> : current?.memory_access ? <>
        <p role="status">Memory permission saved. Continue setup in your assistant.</p>
        <p className="text-sm text-muted-foreground">Your private agent and its secure memory connection must be ready before information can be accessed.</p>
      </> : <>
        <p className="text-muted-foreground">Let this assistant remember what matters to you.</p>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>Read all current and future personal memory.</li>
          <li>Save and correct memory until you disconnect.</li>
          <li>Keep passwords, keys and recovery details excluded.</li>
        </ul>
        <p className="text-sm text-muted-foreground">Deleting, sharing and taking external actions still need your approval.</p>
        <details className="text-sm text-muted-foreground"><summary>How access works</summary>
          <p className="pt-2">The assistant receives the information you allow. Hussh’s MCP gateway may process requests and replies in transit. This permission does not grant vault-key custody or authorize paid infrastructure.</p>
        </details>
        <Button onClick={approve} disabled={!current || busy}>{busy ? "Saving permission…" : "Allow memory access"}</Button>
      </>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  </main>;
}
