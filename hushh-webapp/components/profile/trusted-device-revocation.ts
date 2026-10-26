import { phoneRecoveryId } from "@/lib/auth/phone-recovery-route";
import { ApiService } from "@/lib/services/api-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import type { DeviceRevocationProof, DeviceRevocationStatus } from "@/lib/services/phone-recovery-service";

type Patch = { confirmation?: string | null; unlinked?: readonly string[]; pendingPodRevocations?: string[]; error?: string; uncertain?: boolean };
export type RevocationReceipt = Pick<DeviceRevocationStatus, "operation_id" | "device_id" | "state" | "success" | "podBindingVersion">;
export async function applyDeviceRevocation(device: string, owner: string, current: () => boolean,
  patch: (value: Patch) => void, unlinked: readonly string[], pendingPod: string[],
  refresh: () => Promise<unknown>, proof?: DeviceRevocationProof, receipt?: RevocationReceipt, onSettled?: (podPending: boolean) => void) {
  let committed = false;
  const cacheKey = CACHE_KEYS.TRUSTED_DEVICES(owner);
  // A lost response must force a server read on the next visit as well.
  CacheService.getInstance().invalidate(cacheKey);
  try {
    const result = await ApiService.revokeTrustedDeviceEverywhere(device, owner, current,
      { proof, ...(receipt ? { receipt: Response.json(receipt) } : {}) });
    const response = result.hub;
    const value = await response.clone().json().catch(() => ({}));
    const completed = response.ok && value.state === "completed" && value.success === true;
    if (!completed) {
      if (current()) patch({ error: "Unlinking is not confirmed. Refresh to check its status.", uncertain: true });
      return;
    }
    committed = true;
    const podPending = !result.pod.delivered && !("unpinned" in result.pod && value.podBindingVersion === 0);
    if (!current()) return;
    onSettled?.(podPending);
    patch({ confirmation: null, unlinked: [...new Set([...unlinked, device])], uncertain: false,
      pendingPodRevocations: podPending ? [...new Set([...pendingPod, device])] : pendingPod.filter(id => id !== device) });
    if (await refresh() === null && current()) patch({ error: "Device unlinked. Couldn’t refresh the list." });
  } catch {
    if (current()) patch({ error: committed ? "Device unlinked. Couldn’t refresh the list." :
      "Unlinking is not confirmed. Refresh to check its status.", uncertain: !committed });
  }
}

/** Bounded owner-only journal projection; malformed transport records grant no action. */
export function mergeRevocationReceipts(previous: RevocationReceipt[], incoming: unknown): RevocationReceipt[] {
  const entries = Array.isArray(incoming) ? incoming.slice(0, 20).filter((value): value is RevocationReceipt =>
    !!value && typeof value === "object" && phoneRecoveryId(value.operation_id) !== null &&
    ["prepared", "pending", "action_required", "completed", "not_started", "expired", "stale"].includes(value.state)) : [];
  return [...new Map([...previous, ...entries].map(value => [value.operation_id, value])).values()].slice(-20);
}
