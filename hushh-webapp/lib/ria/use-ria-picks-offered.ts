"use client";

import { usePersonaState } from "@/lib/persona/persona-context";
import { isRiaVerified, riaVerificationStatusOf } from "@/lib/ria/ria-verification";

/**
 * Whether RIA Picks is offered to the signed-in person: only to a verified
 * advisor. Until verification is known Picks is not offered, so it is never
 * shown and then taken away. Shared by the RIA tab strip and the shell's
 * swipe model so both always offer the same tabs.
 */
export function useRiaPicksOffered(): boolean {
  const { riaOnboardingStatus } = usePersonaState();
  return isRiaVerified(riaVerificationStatusOf(riaOnboardingStatus));
}
