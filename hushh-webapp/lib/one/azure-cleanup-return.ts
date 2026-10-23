"use client";

import { AZURE_SIGN_IN_CHANNEL, ANNOUNCE_WAIT_MS } from "./azure-sign-in";

/** A refresh hint, never approval or evidence that resources were removed. */
export type AzureCleanupReturn = {
  ownerId: string;
  operationId: string;
  phase: "inspect" | "execute";
};
type Message = AzureCleanupReturn & {
  type: "azure-cleanup-returned" | "azure-cleanup-ack";
};

function matches(message: Partial<Message> | null, expected: AzureCleanupReturn): boolean {
  return message?.ownerId === expected.ownerId && message.operationId === expected.operationId && message.phase === expected.phase;
}

/** Listen only for the current owner/operation; acknowledge repeats without reapplying them. */
export function listenForAzureCleanupReturn(
  expected: AzureCleanupReturn,
  isCurrent: () => boolean,
  refresh: () => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
  let delivered = false;
  channel.onmessage = (event: MessageEvent<Partial<Message>>) => {
    if (!isCurrent() || event.data?.type !== "azure-cleanup-returned" || !matches(event.data, expected)) return;
    channel.postMessage({ ...expected, type: "azure-cleanup-ack" } satisfies Message);
    if (delivered) return;
    delivered = true;
    refresh();
  };
  return () => channel.close();
}

/** Bounded, cancellable handback. No credentials, resource claims or focus changes. */
export function announceAzureCleanupReturn(
  expected: AzureCleanupReturn,
  signal: AbortSignal,
  timeoutMs = ANNOUNCE_WAIT_MS,
): Promise<boolean> {
  if (signal.aborted || typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  const channel = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
  return new Promise((resolve) => {
    let settled = false;
    const done = (acknowledged: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(repeat);
      signal.removeEventListener("abort", aborted);
      channel.close();
      resolve(acknowledged);
    };
    const aborted = () => done(false);
    const timeout = setTimeout(() => done(false), timeoutMs);
    const repeat = setInterval(() => channel.postMessage({ ...expected, type: "azure-cleanup-returned" }), 400);
    signal.addEventListener("abort", aborted, { once: true });
    channel.onmessage = (event: MessageEvent<Partial<Message>>) => {
      if (event.data?.type === "azure-cleanup-ack" && matches(event.data, expected)) done(true);
    };
    channel.postMessage({ ...expected, type: "azure-cleanup-returned" } satisfies Message);
  });
}
