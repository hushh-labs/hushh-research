"use client";

import type {
  PendingOneSystemRequestInvocation,
  OneSystemRequestInvocationOutcome,
} from "@/lib/capacitor/one-system-request-invocation";
import { OneSystemRequestInvocationBridge } from "@/lib/capacitor/one-system-request-invocation";

// ── Types ────────────────────────────────────────────────────────────────

export type RequestRuntimeState =
  | { status: "idle" }
  | { status: "awaiting_claim"; invocation: PendingOneSystemRequestInvocation }
  | {
      status: "claimed";
      invocation: PendingOneSystemRequestInvocation & { requestText: string };
    }
  | { status: "processing"; invocation: PendingOneSystemRequestInvocation }
  | { status: "completed"; invocation: PendingOneSystemRequestInvocation; outcome: OneSystemRequestInvocationOutcome; summary: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

type Listener = (state: RequestRuntimeState) => void;

// ── Private text lifecycle ───────────────────────────────────────────────

// The 4 KiB private-text cap is enforced in the native coordinator. The text
// is returned only by a successful one-time claim and remains in memory while
// the existing voice owner delivers it as a real user turn.
const REQUEST_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes
const PROTOCOL_VERSION = "one.request.v1";

// ── Runtime ─────────────────────────────────────────────────────────────

/**
 * Stable owner for a single Siri request-capture invocation.
 *
 * Manages the claim → processing → completion/cancellation lifecycle without
 * tying execution to React effect cleanup. Listens for native availability
 * events and claims on the authenticated owner's behalf.
 */
export class OneSystemRequestRuntime {
  private state: RequestRuntimeState = { status: "idle" };
  private listeners = new Set<Listener>();
  private currentOwnerId: string | null = null;
  private claimAttemptId = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCurrentState(): RequestRuntimeState {
    return this.state;
  }

  getCurrentOwnerId(): string | null {
    return this.currentOwnerId;
  }

  setOwner(ownerId: string | null): void {
    if (this.currentOwnerId === ownerId) {
      // A cold, signed-out app can still have a native record created before
      // the WebView mounted. It is not claimable by anyone, so clear it on
      // the first owner sync instead of waiting for the five-minute TTL.
      if (ownerId === null) void OneSystemRequestInvocationBridge.cancelRequest();
      return;
    }

    // Owner changed — cancel any pending request
    if (this.state.status === "awaiting_claim" || this.state.status === "claimed" || this.state.status === "processing") {
      this.cancelCurrent("owner_changed");
    }
    if (ownerId === null || this.currentOwnerId !== null) {
      void OneSystemRequestInvocationBridge.cancelRequest();
    }
    this.currentOwnerId = ownerId;
  }

  /**
   * Start listening for incoming Siri request captures.
   * Must be called when the app is foregrounded and authenticated.
   */
  startListening(): () => void {
    if (!OneSystemRequestInvocationBridge.isSupported()) {
      this.transition({ status: "idle" });
      return () => {};
    }

    // Listen for native availability events
    // addAvailabilityListener returns Promise<PluginListenerHandle>
    const handle = OneSystemRequestInvocationBridge.addAvailabilityListener(
      (invocation) => {
        this.handleNativeAvailability(invocation);
      },
    );

    // Check for an existing pending request on start
    this.pollPending();

    return () => {
      handle.then((h) => h.remove()).catch(() => {});
    };
  }

  /**
   * Attempt to claim the current pending request, if owned by the authenticated user.
   */
  async claimIfOwned(): Promise<boolean> {
    const pending = await OneSystemRequestInvocationBridge.getPendingRequest();
    if (!pending) return false;

    if (pending.ownerBinding !== this.currentOwnerId) {
      // Not owned by current user — silently ignore
      return false;
    }

    // Enforce the lifetime bound rather than only declaring it. Discovery is
    // metadata-only by design, so expiry is checked here from the native
    // timestamps; the 4 KiB text cap is enforced natively, at the only layer
    // that ever sees the private text.
    const expiresAt = Number(pending.expiresAt);
    const createdAt = Number(pending.createdAt);
    const now = Date.now();
    const stale =
      (Number.isFinite(expiresAt) && now > expiresAt) ||
      (Number.isFinite(createdAt) && now - createdAt > REQUEST_LIFETIME_MS);
    if (stale) {
      await OneSystemRequestInvocationBridge.cancelRequest(pending.id);
      this.transition({ status: "failed", error: "request_expired" });
      return false;
    }
    if (now > pending.handoffDeadlineAt) {
      await OneSystemRequestInvocationBridge.cancelRequest(pending.id);
      this.transition({ status: "failed", error: "handoff_timeout" });
      return false;
    }

    return this.claim(pending.id);
  }

  /**
   * Cancel the current request, if any.
   */
  async cancelCurrent(reason: string = "cancelled"): Promise<void> {
    const current = this.state;
    if (
      current.status !== "awaiting_claim" &&
      current.status !== "claimed" &&
      current.status !== "processing"
    ) {
      return;
    }

    const invocationId = current.invocation.id;
    console.debug("[one-request] cancelling", { reason });
    this.transition({ status: "cancelled" });
    await OneSystemRequestInvocationBridge.cancelRequest(invocationId);
  }

  /**
   * Mark the current request as completed with a result.
   */
  async complete(outcome: OneSystemRequestInvocationOutcome, summary: string): Promise<void> {
    const current = this.state;
    if (current.status !== "claimed" && current.status !== "processing") {
      return;
    }

    const invocation = current.invocation;
    await OneSystemRequestInvocationBridge.completeRequest({
      id: invocation.id,
      outcome,
      summary,
    });
    this.transition({ status: "completed", invocation, outcome, summary });
  }

  /**
   * Move a claimed request into the app-owned state before completion. This
   * fence matters when the bridge component unmounts during a route change:
   * Siri detachment may cancel a claim that has not reached the voice owner,
   * but it must never stop a session the owner has already accepted.
   */
  async markAppOwned(): Promise<boolean> {
    const current = this.state;
    if (current.status !== "claimed") return current.status === "processing";
    const reported = await OneSystemRequestInvocationBridge.reportProgress({
      id: current.invocation.id,
      state: "app_owned",
    });
    if (!reported.reported) return false;
    const { requestText: _releasedRequestText, ...invocation } = current.invocation;
    void _releasedRequestText;
    this.transition({ status: "processing", invocation });
    return true;
  }

  async reportProgress(
    state:
      | "pending"
      | "progress"
      | "claimed"
      | "app_owned"
      | "detached"
      | "completed"
      | "cancelled"
      | "expired",
  ): Promise<boolean> {
    const current = this.state;
    if (current.status !== "claimed" && current.status !== "processing") {
      return false;
    }
    const result = await OneSystemRequestInvocationBridge.reportProgress({
      id: current.invocation.id,
      state,
    });
    return result.reported;
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async pollPending(): Promise<void> {
    const pending = await OneSystemRequestInvocationBridge.getPendingRequest();
    if (pending) {
      this.handleNativeAvailability(pending);
    }
  }

  private async handleNativeAvailability(invocation: PendingOneSystemRequestInvocation): Promise<void> {
    // Validate protocol version
    if (invocation.protocolVersion !== PROTOCOL_VERSION) {
      console.warn(`[RequestRuntime] Unsupported protocol version: ${invocation.protocolVersion}`);
      await OneSystemRequestInvocationBridge.cancelRequest(invocation.id);
      return;
    }

    // Validate owner binding
    if (invocation.ownerBinding !== this.currentOwnerId) {
      // Not for us — silently ignore
      return;
    }

    // Validate lifetime
    const now = Date.now();
    if (now > invocation.expiresAt || now > invocation.handoffDeadlineAt) {
      console.warn("[RequestRuntime] Stale request invocation");
      await OneSystemRequestInvocationBridge.cancelRequest();
      this.transition({
        status: "failed",
        error: now > invocation.handoffDeadlineAt ? "handoff_timeout" : "request_expired",
      });
      return;
    }

    // If we already have an active request, cancel the older one
    const current = this.state;
    if (
      current.status === "awaiting_claim" ||
      current.status === "claimed" ||
      current.status === "processing"
    ) {
      if (current.invocation.id === invocation.id) {
        // Capacitor may replay a retained availability event after the first
        // claim. Never cancel a live claim just because the same metadata
        // envelope arrived a second time.
        return;
      }
      await this.cancelCurrent("replaced");
    }

    this.transition({ status: "awaiting_claim", invocation });
    await this.claim(invocation.id);
  }

  private async claim(id: string): Promise<boolean> {
    const current = this.state;
    if (current.status !== "awaiting_claim") return false;
    if (current.invocation.id !== id) return false;

    const attemptId = ++this.claimAttemptId;
    const result = await OneSystemRequestInvocationBridge.claimRequest({ id });

    // Stale guard: another claim may have superseded this one
    if (attemptId !== this.claimAttemptId) return false;
    if (!result.claimed || !result.requestText?.trim()) {
      this.transition({ status: "failed", error: "claim_rejected" });
      return false;
    }
    await OneSystemRequestInvocationBridge.reportProgress({
      id,
      state: "claimed",
    });

    this.transition({
      status: "claimed",
      invocation: {
        ...current.invocation,
        requestText: result.requestText,
      },
    });
    return true;
  }

  private transition(next: RequestRuntimeState): void {
    this.state = next;
    this.listeners.forEach((l) => {
      try {
        l(next);
      } catch (e) {
        console.error("[RequestRuntime] listener error", e);
      }
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const oneSystemRequestRuntime = new OneSystemRequestRuntime();
