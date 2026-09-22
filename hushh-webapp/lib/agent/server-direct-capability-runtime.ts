/**
 * Client projection of the generated CapabilityGraphV1 direct-execution
 * boundary.  This module deliberately contains no mutation implementation:
 * a browser/native client may identify a server-direct capability and submit
 * it to the server, but it can never fall through to a mounted local handler.
 */

import capabilityGraph from "@/contracts/kai/one-capability-graph.v1.json";
import { ApiService } from "@/lib/services/api-service";

type CapabilityExecution = {
  mode?: unknown;
  outcome?: unknown;
  binding_ref?: unknown;
  target?: {
    status?: unknown;
    path?: unknown;
    target?: unknown;
  } | null;
  executor?: {
    kind?: unknown;
    settlement?: unknown;
  } | null;
};

type CapabilityNode = {
  capability_id?: unknown;
  execution?: CapabilityExecution | null;
};

type ServerDirectStatus =
  | "completed"
  | "settling"
  | "paused"
  | "blocked"
  | "failed"
  | "input_needed"
  | "invalid_slots";

export type ServerDirectCapabilityDispatchResult = {
  status: ServerDirectStatus;
  actionId: string;
  message: string;
  runId: string | null;
  missingSlot: "name" | null;
};

function capabilityById(actionId: string): CapabilityNode | null {
  const actions = (capabilityGraph as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return null;
  return (
    actions.find(
      (candidate): candidate is CapabilityNode =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        (candidate as CapabilityNode).capability_id === actionId,
    ) ?? null
  );
}

/**
 * Security classification, deliberately independent of the presentation
 * target. A stale projection that still says `local_handler` must remain
 * *non-executable* in the browser; otherwise a deploy race could turn a
 * server-direct capability back into a mounted page-handler mutation.
 */
export function isServerDirectCapability(actionId: string): boolean {
  const execution = capabilityById(actionId)?.execution;
  return (
    execution?.mode === "server_direct" &&
    execution.outcome === "EXECUTE" &&
    execution.binding_ref === `backend_service:${actionId}` &&
    execution.executor?.kind === "backend_service" &&
    execution.executor.settlement === "verified_backend_service_result"
  );
}

/**
 * Dispatch needs the fully normalized target as well as the security class.
 * Keeping this separate lets all callers fail closed during an artifact skew
 * instead of accidentally treating a legacy target as a safe fallback.
 */
function hasWiredServerDirectTarget(actionId: string): boolean {
  const execution = capabilityById(actionId)?.execution;
  return (
    isServerDirectCapability(actionId) &&
    execution?.target?.status === "wired" &&
    execution?.target?.path === "backend_service" &&
    execution?.target?.target === `backend_service:${actionId}`
  );
}

function failedResult(actionId: string, message: string): ServerDirectCapabilityDispatchResult {
  return {
    status: "failed",
    actionId,
    message,
    runId: null,
    missingSlot: null,
  };
}

function isServerDirectStatus(value: unknown): value is ServerDirectStatus {
  return (
    value === "completed" ||
    value === "settling" ||
    value === "paused" ||
    value === "blocked" ||
    value === "failed" ||
    value === "input_needed" ||
    value === "invalid_slots"
  );
}

/** Submit a structured system handoff to the only executable runtime. */
export async function dispatchServerDirectCapability(input: {
  actionId: string;
  slots: Record<string, unknown>;
  vaultOwnerToken: string | null | undefined;
  invocationId: string;
  signal?: AbortSignal;
}): Promise<ServerDirectCapabilityDispatchResult> {
  if (!hasWiredServerDirectTarget(input.actionId)) {
    return failedResult(
      input.actionId,
      "That action is not available through the secure Agent One runtime.",
    );
  }
  const token = String(input.vaultOwnerToken || "").trim();
  if (!token) {
    return {
      status: "blocked",
      actionId: input.actionId,
      message: "Unlock Agent One before running that action.",
      runId: null,
      missingSlot: null,
    };
  }

  // The Circle contract currently accepts one text slot.  Keep the client
  // projection narrow as well; the backend repeats strict graph-schema
  // validation and does not treat this as an authorization boundary.
  const slots = Object.fromEntries(
    Object.entries(input.slots).filter(
      ([key, value]) => key === "name" && typeof value === "string",
    ),
  ) as Record<string, string>;
  try {
    const response = await ApiService.apiFetch("/api/one/capabilities/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        actionId: input.actionId,
        slots,
        invocationId: input.invocationId,
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      return failedResult(
        input.actionId,
        "Agent One could not safely run that action. Try again in a moment.",
      );
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return failedResult(input.actionId, "Agent One returned an invalid action result.");
    }
    const result = payload as Record<string, unknown>;
    const status = result.status;
    const actionId = result.actionId;
    const message = result.message;
    if (
      !isServerDirectStatus(status) ||
      actionId !== input.actionId ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      return failedResult(input.actionId, "Agent One returned an invalid action result.");
    }
    const runId = typeof result.runId === "string" && result.runId ? result.runId : null;
    const missingSlot = result.missingSlot === "name" ? "name" : null;
    return {
      status,
      actionId,
      message: message.trim(),
      runId,
      missingSlot,
    };
  } catch {
    return failedResult(
      input.actionId,
      "Agent One could not safely run that action. Try again in a moment.",
    );
  }
}
