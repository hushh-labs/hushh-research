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
  | { status: "claimed"; invocation: PendingOneSystemRequestInvocation }
  | { status: "processing"; invocation: PendingOneSystemRequestInvocation }
  | { status: "completed"; invocation: PendingOneSystemRequestInvocation; outcome: OneSystemRequestInvocationOutcome; summary: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

type Listener = (state: RequestRuntimeState) => void;

// ── Private text lifecycle ───────────────────────────────────────────────

// The 4 KiB private-text cap is enforced in the native coordinator, which is
// the only layer that handles the text; claimRequest returns {claimed} alone.
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
  private cancelled = false;
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
    if (this.currentOwnerId === ownerId) return;

    // Owner changed — cancel any pending request
    if (this.state.status === "awaiting_claim" || this.state.status === "claimed" || this.state.status === "processing") {
      this.cancelCurrent("owner_changed");
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
      await OneSystemRequestInvocationBridge.cancelRequest();
      this.transition({ status: "failed", error: "request_expired" });
      return false;
    }

    return this.claim(pending.id);
  }

  /**
   * Cancel the current request, if any.
   */
  async cancelCurrent(reason: string = "cancelled"): Promise<void> {
    const current = this.state;
    if (current.status === "idle" || current.status === "completed" || current.status === "failed") {
      return;
    }

    this.cancelled = true;
    console.debug("[one-request] cancelling", { reason });
    await OneSystemRequestInvocationBridge.cancelRequest();
    this.transition({ status: "cancelled" });
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
      await OneSystemRequestInvocationBridge.cancelRequest();
      return;
    }

    // Validate owner binding
    if (invocation.ownerBinding !== this.currentOwnerId) {
      // Not for us — silently ignore
      return;
    }

    // Validate lifetime
    if (Date.now() > invocation.expiresAt) {
      console.warn("[RequestRuntime] Stale request invocation");
      await OneSystemRequestInvocationBridge.cancelRequest();
      return;
    }

    // If we already have an active request, cancel the older one
    const current = this.state;
    if (
      current.status === "awaiting_claim" ||
      current.status === "claimed" ||
      current.status === "processing"
    ) {
      await this.cancelCurrent("replaced");
    }

    this.transition({ status: "awaiting_claim", invocation });
  }

  private async claim(id: string): Promise<boolean> {
    const current = this.state;
    if (current.status !== "awaiting_claim") return false;
    if (current.invocation.id !== id) return false;

    const attemptId = ++this.claimAttemptId;
    const result = await OneSystemRequestInvocationBridge.claimRequest({ id });

    // Stale guard: another claim may have superseded this one
    if (attemptId !== this.claimAttemptId) return false;
    if (!result.claimed) return false;

    this.transition({ status: "claimed", invocation: current.invocation });
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
