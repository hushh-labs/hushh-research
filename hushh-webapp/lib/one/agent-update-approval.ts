import { readUpdateStatus, type AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import {
  AzureSignInUnavailableError,
  azureSignInErrorMessage,
  isAzureSignInAvailable,
  startAzureSignIn,
} from "@/lib/one/azure-sign-in";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";

export type AgentUpdateApproval = "scheduled" | "signing_in";

/** The hub's bound on `idempotencyKey` (`UpgradeApprovalRequest`). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const APPROVE_FAILED = "AGENT_UPDATE_APPROVE_FAILED:";

/**
 * The one operation key an Azure agent's approval of `releaseId` ever uses.
 *
 * The hub records an approval once per release and refuses a second key for
 * it. An Azure approval is finished by a separate Microsoft sign-in the person
 * can cancel, so a fresh key per click would turn "come back and continue"
 * into a refusal. Deriving the key from the release makes every return,
 * from any tab or device, the same idempotent request.
 */
export function azureUpdateIdempotencyKey(releaseId: string): string {
  const key = `azure-update.${releaseId.trim()}`;
  if (!releaseId.trim() || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`${APPROVE_FAILED}release`);
  }
  return key;
}

/**
 * Recorded, and nothing has started it yet. The hub projects an `approved`
 * approval as `scheduled` with the `scheduled` phase; any later milestone
 * means the update itself is moving.
 */
export function isApprovedNotStarted(update: AgentUpdateStatus): boolean {
  return (
    !update.failed &&
    update.presentationState === "scheduled" &&
    (update.phase === "scheduled" || update.phase === null)
  );
}

async function hasApprovalFor(releaseId: string): Promise<boolean> {
  const update = readUpdateStatus(await ApiService.getPersonalAgentStatus().catch(() => null));
  return update.releaseId === releaseId && isApprovedNotStarted(update);
}

/**
 * Record the person's approval of exactly `releaseId` before any sign-in.
 * When the hub refuses because this same release is already approved (under
 * another device's or an older client's key), the approval stands and only the
 * sign-in is missing, so the person continues to it.
 */
async function recordAzureApproval(releaseId: string): Promise<void> {
  try {
    await ApiService.approvePersonalAgentUpdate({
      releaseId,
      idempotencyKey: azureUpdateIdempotencyKey(releaseId),
    });
  } catch (cause) {
    if (await hasApprovalFor(releaseId)) return;
    throw cause;
  }
}

/**
 * Approve the offered agent update the way the agent's home requires.
 *
 * Every home records the approval through the hub, which binds it to this pod
 * incarnation and the exact `releaseId` the person was shown. A home the hub
 * schedules uses the caller's `idempotencyKey`. An Azure agent cannot be
 * changed by Hussh's standing access (see/restart only), so after the approval
 * is recorded, under its per-release key, the person's own Microsoft sign-in
 * authorizes that one update and the browser leaves for Microsoft.
 */
export async function approveAgentUpdate(input: {
  deploymentTarget: string | null | undefined;
  releaseId: string;
  idempotencyKey: string;
}): Promise<AgentUpdateApproval> {
  if (ownerCloudProvider(input.deploymentTarget) === "azure") {
    // Never record an approval this device cannot carry on to Microsoft.
    if (!isAzureSignInAvailable()) throw new AzureSignInUnavailableError();
    await recordAzureApproval(input.releaseId);
    await startAzureSignIn("upgrade");
    return "signing_in";
  }
  await ApiService.approvePersonalAgentUpdate({
    releaseId: input.releaseId,
    idempotencyKey: input.idempotencyKey,
  });
  return "scheduled";
}

/** One plain sentence for a failed Azure approval, whichever half failed. */
export function azureUpdateApprovalErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.startsWith(APPROVE_FAILED)) {
    return cause.message.endsWith(":409")
      ? "This update changed. Check for updates to see the current one."
      : "We couldn’t record your approval. Your agent keeps its current version; try again in a moment.";
  }
  return azureSignInErrorMessage(cause, "upgrade");
}

/** The approve toast's copy for the agent's home. */
export function agentUpdateApprovalToast(deploymentTarget: unknown): {
  loading: string;
  success: string;
  error: string | ((cause: unknown) => string);
} {
  return ownerCloudProvider(deploymentTarget) === "azure"
    ? {
        loading: "Opening Microsoft sign-in…",
        success: "Continue in Microsoft sign-in.",
        error: azureUpdateApprovalErrorMessage,
      }
    : {
        loading: "Scheduling your update…",
        success: "Update scheduled.",
        error: "We couldn’t complete that request. Try again.",
      };
}
