/**
 * One recovery decision, shared by every surface that shows a failed/unreachable
 * agent (the chat workspace banner and the home/setup presence chip).
 *
 * WHY THIS IS SHARED, AND WHY THE VERB MATTERS
 * --------------------------------------------
 * The two surfaces used to disagree: the chat probed the pod before doing
 * anything, but the presence chip's "Rebuild" went straight to
 * provisionPersonalAgent. That difference is not cosmetic. Per the private-agent
 * north star, the pod's HusshID is deterministic and load-bearing: consent
 * receipts, the A2A address, and the agent's persistent MEMORY all hang off it.
 *
 *   - WAKE / RECONNECT preserves the identity and the memory. It is the default.
 *   - REBUILD mints a NEW identity and discards the memory. It is the last resort,
 *     and only justified when the pod is confirmed gone AND the person's cloud is
 *     still reachable (a gone project needs reinit, not a rebuild into nothing).
 *
 * So recovery always PROBES first (wakePod round-trips to the pod through the hub
 * relay and reports awake / waking / gone), and only the caller, on a confirmed
 * `rebuildable`, ever mints a new identity.
 */
import { ApiService } from "@/lib/services/api-service";

export type AgentRecoveryOutcome =
  | { kind: "reconnected" } // pod answered; nothing to rebuild, clear the banner
  | { kind: "waking"; etaMs: number } // cold pod scaling up; wait, do not rebuild
  | { kind: "needs_reinit" } // host/project gone; route to cloud reconnect, NOT provision
  | { kind: "rebuildable" } // confirmed gone, cloud reachable; a new-identity rebuild is warranted
  | { kind: "error"; message: string };

/**
 * Probe the caller's own pod and classify what recovery it needs. Never mints a
 * new identity itself — it returns `rebuildable` and lets the caller decide.
 * `podHushhId` short-circuits with a direct reachability probe when known.
 */
export async function classifyAgentRecovery(options: {
  podHushhId?: string | null;
}): Promise<AgentRecoveryOutcome> {
  const { podHushhId } = options;
  // Fast path: a known pod that answers is simply reconnected.
  if (podHushhId) {
    try {
      const info = await ApiService.getPodInfo(podHushhId);
      if (info.podStatus === 200) return { kind: "reconnected" };
    } catch {
      // fall through to the wake probe
    }
  }
  try {
    const wake = await ApiService.wakePod();
    if (wake.state === "awake") return { kind: "reconnected" };
    if (wake.state === "waking") return { kind: "waking", etaMs: wake.etaMs };
    // gone: before deciding reinit vs rebuild, try to ADOPT. The registry row may be
    // lost while the person's pod is still running in their own project (they
    // uninstalled and came back). Adoption reconnects to that existing pod, preserving
    // identity and memory -- the WAKE/RECONNECT side of the north star, so it is the
    // automatic preference, not a user choice. Its success IS reconnected (or waking,
    // if the adopted pod is still warming). Only when nothing is adoptable do we fall
    // through to reinit (project gone) or rebuild (new identity, last resort).
    const adopted = await ApiService.adoptOrphanPod().catch(() => null);
    if (adopted?.adopted) {
      return adopted.status === "provisioned"
        ? { kind: "reconnected" }
        : { kind: "waking", etaMs: wake.etaMs };
    }
    return wake.needsFreshSetup ? { kind: "needs_reinit" } : { kind: "rebuildable" };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "recovery probe failed",
    };
  }
}
