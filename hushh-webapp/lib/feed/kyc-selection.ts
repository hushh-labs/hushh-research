import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

let pending: {
  userId: string;
  workflowId: string;
  generation: ReturnType<typeof getAuthSessionGeneration>;
  epoch: ReturnType<typeof snapshotVaultSessionEpoch>;
} | null = null;

export function selectKycRequestFromFeed(userId: string, workflowId: string) {
  pending = {
    userId,
    workflowId,
    generation: getAuthSessionGeneration(),
    epoch: snapshotVaultSessionEpoch(),
  };
}

export function takeFeedKycSelection(userId: string): string | null {
  const selection = pending;
  pending = null;
  return selection?.userId === userId
    && selection.generation === getAuthSessionGeneration()
    && isVaultSessionEpochCurrent(selection.epoch)
    ? selection.workflowId : null;
}
