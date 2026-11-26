import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";

/**
 * True ONLY when the signed-in owner runs in an external customer-owned cloud
 * (`byoc`) or an unplaced/pending/unknown hosting state where hussh-operated
 * specialist surfaces (Finance/Kai, Plaid, Mail Receipts, Information Requests,
 * Calendar Invitations/Booking, Drive Packets, Live Voice, Career) must stay
 * off the hub.
 *
 * Returns `false` for both `shared` AND `hussh_pods` (Confidential Sandbox),
 * restoring full one-click parity across every workspace while Chat, Files,
 * Memory/Wiki, Browser/Computer Use, and Tasks continue running directly inside
 * the owner's Confidential Sandbox microVM via `usesOwnerPod`.
 */
export async function ownerRequiresByocIsolation(): Promise<boolean> {
  if (!(await ownerContentIsPrivate())) return false;
  try {
    const { ApiService } = await import("@/lib/services/api-service");
    if (typeof ApiService?.getPersonalAgentStatus !== "function") return true;
    const status = await ApiService.getPersonalAgentStatus();
    if (status?.hostingMode === "hussh_pods" || status?.hostingMode === "shared") {
      return false;
    }
  } catch {
    // Fail closed to external-cloud isolation if status read fails after pod admission.
  }
  return true;
}
