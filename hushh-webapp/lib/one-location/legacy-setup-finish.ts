import type { LocalOnboardingActionResult } from "@/lib/agent/local-onboarding-actions";
import { OneLocationOnboardingRunClient } from "@/lib/services/one-location-onboarding-run-client";

/** The legacy finish action can acknowledge only an owner-verified server run. */
export async function finishVerifiedLocationSetup({
  userId,
  runId,
  isCurrent,
  onVerified,
}: {
  userId: string | null;
  runId: string | null;
  isCurrent: () => boolean;
  onVerified: () => void;
}): Promise<LocalOnboardingActionResult> {
  const blocked: LocalOnboardingActionResult = {
    status: "blocked",
    summary: "Use Finish Location introduction to complete this introduction. Existing Location tasks finish after their verification is complete.",
  };
  if (!userId || !runId || !isCurrent()) return blocked;
  try {
    const result = await OneLocationOnboardingRunClient.get(runId, {
      expectedUserId: userId,
    });
    if (!isCurrent()) return blocked;
    if (
      result.run.runId !== runId ||
      result.run.status !== "verified_succeeded" ||
      !result.run.completionClaimAllowed
    ) return blocked;
    onVerified();
    return { status: "succeeded", summary: "Location setup is verified." };
  } catch {
    if (!isCurrent()) return blocked;
    return { status: "failed", summary: "Could not verify the existing Location task. Please try again." };
  }
}
