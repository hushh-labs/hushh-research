"use client";

import {
  Capacitor,
  type PluginListenerHandle,
} from "@capacitor/core";
import { NativeOneVoiceInvocation } from "@/lib/capacitor/one-voice-invocation";

// ── Types ────────────────────────────────────────────────────────────────

export type OneSystemRequestStatus = "pending" | "progress" | "completed" | "cancelled" | "expired";

export type PendingOneSystemRequestInvocation = {
  id: string;
  kind: "interpret_one_request";
  source: "siri_app_shortcut";
  createdAt: number;
  expiresAt: number;
  handoffDeadlineAt: number;
  claimedAt?: number | null;
  appOwnedAt?: number | null;
  detached?: boolean;
  outcome?: string | null;
  protocolVersion: string;
  ownerBinding: string;
};

export type OneSystemRequestInvocationOutcome =
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "clarification_required"
  | "handoff_timeout"
  | "owner_mismatch"
  | "runtime_unavailable"
  | "provider_unavailable"
  | "ambiguous"
  | "voice_disabled";

// ── Plugin interface ─────────────────────────────────────────────────────

export interface NativeOneSystemRequestInvocationPlugin {
  getPendingRequestInvocation(): Promise<Partial<PendingOneSystemRequestInvocation>>;
  claimRequestInvocation(options: {
    id: string;
  }): Promise<{ claimed: boolean; requestText?: string }>;
  completeRequestInvocation(options: {
    id: string;
    outcome: OneSystemRequestInvocationOutcome;
    summary: string;
  }): Promise<void>;
  reportRequestInvocationProgress(options: {
    id: string;
    state: string;
  }): Promise<{ reported: boolean }>;
  cancelRequestInvocation(options?: { id?: string }): Promise<void>;
  addListener(
    eventName: "systemRequestInvocationAvailable",
    listener: (invocation: PendingOneSystemRequestInvocation) => void,
  ): Promise<PluginListenerHandle>;
}

// ── Web fallback ─────────────────────────────────────────────────────────

// Web/Android fallbacks for these methods live on the shared
// HushhVoiceInvocation registration in one-voice-invocation.ts.

// ── Registered plugin ────────────────────────────────────────────────────

// Deliberately NOT a second registerPlugin call. The request methods live on the
// same native plugin as the voice/action methods (jsName "HushhVoiceInvocation"),
// and Capacitor refuses a duplicate registration: it warns and returns the FIRST
// proxy, so a second call here would silently inherit the voice web fallback and
// leave every request method undefined in a browser or test build.
export const NativeOneSystemRequestInvocation =
  NativeOneVoiceInvocation as unknown as NativeOneSystemRequestInvocationPlugin;

// ── Runtime guards ───────────────────────────────────────────────────────

function isPendingRequestInvocation(
  value: Partial<PendingOneSystemRequestInvocation> | null | undefined,
): value is PendingOneSystemRequestInvocation {
  return (
    value?.kind === "interpret_one_request" &&
    value.source === "siri_app_shortcut" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.handoffDeadlineAt === "number" &&
    Number.isFinite(value.handoffDeadlineAt) &&
    typeof value.protocolVersion === "string" &&
    value.protocolVersion.length > 0 &&
    typeof value.ownerBinding === "string"
  );
}

// ── Public bridge ────────────────────────────────────────────────────────

export const OneSystemRequestInvocationBridge = {
  isSupported(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  },

  async getPendingRequest(): Promise<PendingOneSystemRequestInvocation | null> {
    if (!this.isSupported()) return null;
    const invocation = await NativeOneSystemRequestInvocation.getPendingRequestInvocation();
    return isPendingRequestInvocation(invocation) ? invocation : null;
  },

  async claimRequest(options: {
    id: string;
  }): Promise<{ claimed: boolean; requestText?: string }> {
    if (!this.isSupported()) return { claimed: false };
    const result = await NativeOneSystemRequestInvocation.claimRequestInvocation(
      options,
    );
    if (!result.claimed) return { claimed: false };
    const requestText = result.requestText;
    if (typeof requestText !== "string" || !requestText.trim()) {
      return { claimed: false };
    }
    return { claimed: true, requestText };
  },

  async reportProgress(options: {
    id: string;
    state:
      | "pending"
      | "progress"
      | "claimed"
      | "app_owned"
      | "detached"
      | "completed"
      | "cancelled"
      | "expired";
  }): Promise<{ reported: boolean }> {
    if (!this.isSupported()) return { reported: false };
    return NativeOneSystemRequestInvocation.reportRequestInvocationProgress({
      id: options.id,
      state: options.state,
    });
  },

  async completeRequest(options: {
    id: string;
    outcome: OneSystemRequestInvocationOutcome;
    summary: string;
  }): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneSystemRequestInvocation.completeRequestInvocation(options);
  },

  async cancelRequest(id?: string): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneSystemRequestInvocation.cancelRequestInvocation(id ? { id } : undefined);
  },

  async addAvailabilityListener(
    listener: (invocation: PendingOneSystemRequestInvocation) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.isSupported()) return { remove: async () => undefined };
    return NativeOneSystemRequestInvocation.addListener(
      "systemRequestInvocationAvailable",
      listener,
    );
  },
};
