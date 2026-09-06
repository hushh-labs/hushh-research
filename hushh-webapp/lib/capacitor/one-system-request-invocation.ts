"use client";

import {
  Capacitor,
  WebPlugin,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

// ── Types ────────────────────────────────────────────────────────────────

export type OneSystemRequestStatus = "pending" | "progress" | "completed" | "cancelled" | "expired";

export type PendingOneSystemRequestInvocation = {
  id: string;
  kind: "interpret_one_request";
  source: "siri_app_shortcut";
  createdAt: number;
  expiresAt: number;
  protocolVersion: string;
  ownerBinding: string;
};

export type OneSystemRequestInvocationOutcome =
  "completed" | "failed" | "expired" | "cancelled" | "clarification_required";

// ── Plugin interface ─────────────────────────────────────────────────────

export interface NativeOneSystemRequestInvocationPlugin {
  getPendingRequestInvocation(): Promise<Partial<PendingOneSystemRequestInvocation>>;
  claimRequestInvocation(options: { id: string }): Promise<{ claimed: boolean }>;
  completeRequestInvocation(options: {
    id: string;
    outcome: OneSystemRequestInvocationOutcome;
    summary: string;
  }): Promise<void>;
  reportRequestInvocationProgress(options: {
    id: string;
    state: string;
  }): Promise<{ reported: boolean }>;
  cancelRequestInvocation(): Promise<void>;
  addListener(
    eventName: "systemRequestInvocationAvailable",
    listener: (invocation: PendingOneSystemRequestInvocation) => void,
  ): Promise<PluginListenerHandle>;
}

// ── Web fallback ─────────────────────────────────────────────────────────

class OneSystemRequestInvocationWeb extends WebPlugin {
  async getPendingRequestInvocation(): Promise<Record<string, never>> {
    return {};
  }
  async claimRequestInvocation(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }
  async completeRequestInvocation(): Promise<void> {}
  async reportRequestInvocationProgress(): Promise<{ reported: boolean }> {
    return { reported: false };
  }
  async cancelRequestInvocation(): Promise<void> {}
}

// ── Registered plugin ────────────────────────────────────────────────────

export const NativeOneSystemRequestInvocation =
  registerPlugin<NativeOneSystemRequestInvocationPlugin>(
    "HushhRequestInvocation",
    { web: () => Promise.resolve(new OneSystemRequestInvocationWeb()) },
  );

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

  async claimRequest(options: { id: string }): Promise<{ claimed: boolean }> {
    if (!this.isSupported()) return { claimed: false };
    return NativeOneSystemRequestInvocation.claimRequestInvocation(options);
  },

  async reportProgress(options: {
    id: string;
    state: "pending" | "progress" | "completed" | "cancelled" | "expired";
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

  async cancelRequest(): Promise<void> {
    if (!this.isSupported()) return;
    await NativeOneSystemRequestInvocation.cancelRequestInvocation();
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
