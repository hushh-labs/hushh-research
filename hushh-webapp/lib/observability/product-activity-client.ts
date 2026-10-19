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
let admission: { scope: ProductActivityScope; value: Promise<Admission> } | null = null;
let pending = 0;

async function send(actionId: string, phase: Phase, operationId: string, scope: ProductActivityScope | null) {
  if (!scope || !isProductActivityScopeCurrent(scope) || pending >= 4) return;
  pending++;
  try {
    const token = await ApiService.getFirebaseIdTokenForOwner(scope.owner.userId);
    if (!token || !isProductActivityScopeCurrent(scope)) return;
    const options = { headers: { Authorization: `Bearer ${token}` },
      isEffectCurrent: () => isProductActivityScopeCurrent(scope) };
    if (!admission || !isProductActivityScopeCurrent(admission.scope)) {
      admission = { scope, value: ApiService.apiFetch("/api/one/plg/activity", options)
        .then(async (response) => response.ok ? await response.json() as Admission : { enabled: false }) };
    }
    const allowed = await admission.value;
    if (!allowed.enabled || !allowed.generation || !isProductActivityScopeCurrent(scope)) return;
    await ApiService.apiFetch("/api/one/plg/activity", { ...options, method: "POST",
      body: JSON.stringify({ generation: allowed.generation, actionId, phase, operationId }) });
  } catch {
    // Collection failure never affects product execution. A new authenticated
    // owner generation may discover admission again; old observations are lost.
  } finally { pending--; }
}

export function observeProductAction(actionId: string, phase: Phase, operationId?: string): void {
  if (typeof window === "undefined") return;
  const id = operationId ?? globalThis.crypto?.randomUUID?.();
  if (id) void send(actionId, phase, id, snapshotProductActivityScope());
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
  if (id && typeof window !== "undefined") void send(key, phase, id, scope);
}

/** Wrap a completed dispatch without delaying a trusted browser activation. */
export function observeDispatch<T extends { status: string }>(
  actionId: string, operation: Promise<T>,
): Promise<T> {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) return operation;
  const scope = snapshotProductActivityScope();
  if (typeof window !== "undefined") void send(actionId, "started", id, scope);
  return operation.then((result) => {
    const phase = result.status === "succeeded" || result.status === "completed" ? "returned"
      : result.status === "started" || result.status === "settling" ? "started"
      : result.status === "failed" ? "failed" : "blocked";
    if (typeof window !== "undefined") void send(actionId, phase, id, scope);
    return result;
  }, (error: unknown) => {
    if (typeof window !== "undefined") void send(actionId, error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed", id, scope);
    throw error;
  });
}
