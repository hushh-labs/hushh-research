"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import { parseAccountCleanupOperation, type AccountCleanupOperation } from "@/lib/auth/account-cleanup-operation";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { withDeadline } from "@/lib/utils/with-deadline";

/** Bounded aggregate only: cleanup responses contain no credentials or content. */
async function readCleanup(response: Response): Promise<AccountCleanupOperation | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new Error("Cleanup response exceeds its limit.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parseAccountCleanupOperation(
      payload && typeof payload === "object" ? (payload as { operation?: unknown }).operation : null,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function SessionVerificationRecovery({ onRetry, onSignOut }: {
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const { user } = useAuth();
  const [operation, setOperation] = useState<AccountCleanupOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [acceptLocalErasure, setAcceptLocalErasure] = useState(false);
  const epoch = useRef(0);
  const active = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    ++epoch.current;
    active.current?.abort();
  }, []);

  const load = useCallback(async (review?: AccountCleanupOperation) => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (!user || !owner || user.uid !== owner.userId) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const request = ++epoch.current;
    const current = () => request === epoch.current && !controller.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner);
    const deadline = Date.now() + 12_000;
    const timeout = globalThis.setTimeout(() => controller.abort(), 12_000);
    setBusy(true); setError(false);
    try {
      const token = await withDeadline(user.getIdToken(false), deadline);
      if (!current()) return;
      const response = review
        ? await ApiService.continueAccountCleanup(token, review, review.local_erasure_confirmation_required, current, controller.signal)
        : await ApiService.getAccountCleanupStatus(token, controller.signal);
      const observed = await withDeadline(readCleanup(response), deadline);
      if (!current()) return;
      if (observed) {
        setOperation(observed);
        setAcceptLocalErasure(false);
      } else if (review || response.status !== 404) {
        setError(true);
      }
    } catch {
      if (request === epoch.current && isValidatedAuthSessionOwnerCurrent(owner)) setError(true);
    } finally {
      globalThis.clearTimeout(timeout);
      if (request === epoch.current && isValidatedAuthSessionOwnerCurrent(owner)) setBusy(false);
    }
  }, [user]);

  useEffect(() => {
    setOperation(null); setAcceptLocalErasure(false);
    void load();
    return cancel;
  }, [load, cancel]);

  const title = !operation ? "Reconnect to continue securely"
    : operation.state === "complete" ? "Your information has been deleted"
    : operation.state === "action_required" ? "Finish account cleanup"
    : operation.state === "waiting_for_provider" ? "Waiting for your provider"
    : "Cleaning up your account";
  const description = !operation
    ? "We couldn’t verify this account, so your private information stayed hidden. Check your connection and try again."
    : operation.state === "complete"
      ? "Your external sign-in remains unchanged. Continue to finish signing out."
      : "New agent work is paused while we remove your information and access. You can close this page; approved cleanup will continue.";
  const localReview = operation?.state === "action_required" && operation.local_erasure_confirmation_required;

  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-background px-6 py-12">
      <section aria-labelledby="session-verification-title" className="w-full max-w-md rounded-3xl border border-border/70 bg-card p-7 text-center shadow-sm" role={operation ? "status" : "alert"} aria-live={operation ? "polite" : "assertive"}>
        <h1 id="session-verification-title" className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
        {localReview && <label className="mt-5 flex items-start gap-3 text-left text-sm leading-6">
          <input type="checkbox" className="mt-1" checked={acceptLocalErasure} onChange={event => setAcceptLocalErasure(event.target.checked)} disabled={busy} />
          <span>Remove Hussh’s saved credentials without revoking external access. This can include shared sign-in connections and keys that cannot be revoked here. They may remain valid with the provider.</span>
        </label>}
        {operation?.state === "action_required" && !localReview && <p className="mt-3 text-sm text-muted-foreground">Provider access could not be confirmed. Retry cleanup or contact support if it still needs attention.</p>}
        {error && <p className="mt-3 text-sm text-destructive">We couldn’t confirm the latest status. Your cleanup request is preserved.</p>}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
          {operation?.state === "action_required" && <button type="button" className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background disabled:opacity-50" disabled={busy || (localReview && !acceptLocalErasure)} onClick={() => void load(operation)}>{localReview ? "Remove Hussh’s copy" : "Retry cleanup"}</button>}
          <button className="min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground disabled:opacity-50" disabled={busy} onClick={operation && operation.state !== "complete" ? () => void load() : onRetry} type="button">{busy ? "Checking…" : operation?.state === "complete" ? "Continue" : operation ? "Refresh status" : "Try again"}</button>
          <button className="min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground" onClick={onSignOut} type="button">Sign out</button>
        </div>
      </section>
    </main>
  );
}
