/** Private pilot observations. No payloads, durable queue, retries or send authority. */
import contract from "@/contracts/plg/observability-actions.v1.json";
import {
  snapshotProductActivityScope,
  isProductActivityScopeCurrent,
  type ProductActivityScope,
} from "./product-activity-scope";
import { ApiService } from "@/lib/services/api-service";

type Phase = "started" | "returned" | "failed" | "cancelled" | "blocked";
type Admission = { enabled: boolean; generation?: string };
type Observation = { scope: ProductActivityScope | null; admitted: Promise<Admission> };
let admission: { scope: ProductActivityScope; capturedAt: number; value: Promise<Admission> } | null = null;
let pending = 0;

function observation(scope: ProductActivityScope | null): Observation {
  if (!scope || !isProductActivityScopeCurrent(scope))
    return { scope, admitted: Promise.resolve({ enabled: false }) };
  if (!admission || !isProductActivityScopeCurrent(admission.scope) || Date.now() - admission.capturedAt >= 60_000) {
    admission = { scope, capturedAt: Date.now(), value: (async () => {
      const token = await ApiService.getFirebaseIdTokenForOwner(scope.owner.userId);
      if (!token || !isProductActivityScopeCurrent(scope)) return { enabled: false };
      const response = await ApiService.apiFetch("/api/one/plg/activity", {
        headers: { Authorization: `Bearer ${token}` },
        isEffectCurrent: () => isProductActivityScopeCurrent(scope),
      });
      return response.ok ? await response.json() as Admission : { enabled: false };
    })().catch(() => ({ enabled: false })) };
  }
  // A new operation may refresh admission; terminal reports retain this exact
  // promise/epoch even after another device resets the account.
  return { scope, admitted: admission.value };
}

async function send(actionId: string, phase: Phase, operationId: string, captured: Observation) {
  const { scope } = captured;
  if (!scope || !isProductActivityScopeCurrent(scope) || pending >= 4) return;
  pending++;
  try {
    const allowed = await captured.admitted;
    if (!allowed.enabled || !allowed.generation || !isProductActivityScopeCurrent(scope)) return;
    const token = await ApiService.getFirebaseIdTokenForOwner(scope.owner.userId);
    if (!token || !isProductActivityScopeCurrent(scope)) return;
    const options = { headers: { Authorization: `Bearer ${token}` },
      isEffectCurrent: () => isProductActivityScopeCurrent(scope) };
    await ApiService.apiFetch("/api/one/plg/activity", { ...options, method: "POST",
      body: JSON.stringify({ generation: allowed.generation, actionId, phase, operationId }) });
  } catch {
    // Collection failure never affects execution. New operations can discover
    // admission again after the bounded cache expires; old reports are lost.
  } finally { pending--; }
}

export function observeProductAction(actionId: string, phase: Phase, operationId?: string): void {
  if (typeof window === "undefined") return;
  const id = operationId ?? globalThis.crypto?.randomUUID?.();
  if (id) void send(actionId, phase, id, observation(snapshotProductActivityScope()));
}

export function observeProductEvent(event: string, action: unknown, result: unknown, scope = snapshotProductActivityScope()): void {
  if (!Object.hasOwn(contract.events, event)) return;
  const values = (contract.events as Record<string, string[]>)[event];
  if (!values) return;
  if (values.length && (typeof action !== "string" || !values.includes(action))) return;
  const key = `observation:${event}${values.length ? `:${action}` : ""}`;
  const phase = result === "error" || result === "expected_error" ? "failed"
    : event.endsWith("_started") ? "started" : "returned";
  const id = globalThis.crypto?.randomUUID?.();
  if (id && typeof window !== "undefined") void send(key, phase, id, observation(scope));
}

/** Wrap a completed dispatch without delaying a trusted browser activation. */
export function observeDispatch<T extends { status: string }>(
  actionId: string, operation: Promise<T>,
): Promise<T> {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) return operation;
  const captured = observation(snapshotProductActivityScope());
  if (typeof window !== "undefined") void send(actionId, "started", id, captured);
  return operation.then((result) => {
    const phase = result.status === "succeeded" || result.status === "completed" ? "returned"
      : result.status === "started" || result.status === "settling" ? "started"
      : result.status === "failed" ? "failed" : "blocked";
    if (typeof window !== "undefined") void send(actionId, phase, id, captured);
    return result;
  }, (error: unknown) => {
    if (typeof window !== "undefined") void send(actionId, error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed", id, captured);
    throw error;
  });
}
