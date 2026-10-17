import type { ApiService } from "@/lib/services/api-service";
import { releaseLabel } from "@/lib/feed/agent-update-status";
import type { ReleaseNotice } from "@/lib/agent/managed-app-release";

export type PersonalAgentStatus = Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>;
export const POD_UPDATE_OBSERVED_EVENT = "hushh:pod-update-observed";

export function completedPodNotice(status: PersonalAgentStatus): ReleaseNotice | null {
  const receipt = status.completedUpdate;
  if (!status.installedReleaseVerified || !receipt?.operationId || !receipt.releaseId ||
      !receipt.podIncarnation || !receipt.verifiedAt ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest) ||
      receipt.imageDigest !== status.installedRelease?.imageDigest) return null;
  const notes = receipt.notes;
  const changes = notes ? [...notes.improvements, ...notes.fixes, ...notes.security].slice(0, 3) : [];
  return {
    id: `pod:${receipt.podIncarnation}:${receipt.operationId}:${receipt.releaseId}:${receipt.imageDigest}`,
    title: "Your private agent is updated",
    description: receipt.version ? `Installed version: ${releaseLabel(receipt.version, receipt.releasedAt)}` : "Your installed version is verified.",
    changes: changes.length ? changes : ["The installed version has been verified."],
  };
}

/** Carries public receipts only; never authority, credentials or private content. */
export function publishPodUpdateObservation(ownerId: string | null | undefined, status: PersonalAgentStatus): void {
  const notice = completedPodNotice(status);
  if (!ownerId || !notice || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(POD_UPDATE_OBSERVED_EVENT, {
    detail: { ownerId, notice },
  }));
}
