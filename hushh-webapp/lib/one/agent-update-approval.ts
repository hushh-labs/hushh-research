import { startAzureSignIn } from "@/lib/one/azure-sign-in";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";

export type AgentUpdateApproval = "scheduled" | "signing_in";

/**
 * Approve the offered agent update the way the agent's home requires.
 *
 * Every home but Azure schedules through the hub, which binds the approval to
 * this pod incarnation and the exact release. An Azure agent cannot be changed
 * by Hussh's standing access (see/restart only), so Approve starts the person's
 * own Microsoft sign-in instead; the hub binds the offered release when that
 * sign-in completes, and the browser leaves for Microsoft.
 */
export async function approveAgentUpdate(input: {
  deploymentTarget: string | null | undefined;
  releaseId: string;
  idempotencyKey: string;
}): Promise<AgentUpdateApproval> {
  if (ownerCloudProvider(input.deploymentTarget) === "azure") {
    await startAzureSignIn("upgrade");
    return "signing_in";
  }
  await ApiService.approvePersonalAgentUpdate({
    releaseId: input.releaseId,
    idempotencyKey: input.idempotencyKey,
  });
  return "scheduled";
}
