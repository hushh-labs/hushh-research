"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { profileHostingSetupHref } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

/** Preserve one return contract for shell Back, Android Back and Finish. */
export function useCloudSetupManagementReturn(userId: string | undefined, ownerCurrent: () => boolean) {
  const router = useRouter();
  const search = useSearchParams();
  useEffect(() => {
    if (!userId || !ownerCurrent() || search.has("from")) return;
    if (search.get("return_to") === ROUTES.PROFILE_HOSTING) {
      router.replace(profileHostingSetupHref());
      return;
    }
    if (search.has("return_to")) return;
    let active = true;
    const apply = (completed: boolean) => {
      if (active && completed && ownerCurrent())
        router.replace(profileHostingSetupHref());
    };
    const cached = PreVaultUserStateService.getCachedBootstrapState(userId);
    if (OneSetupCompletionHintService.isResolved(userId) || cached) {
      apply(OneSetupCompletionHintService.isResolved(userId) || cached?.setupCompleted === true);
    } else {
      void PreVaultUserStateService.bootstrapState(userId)
        .then((state) => apply(state.setupCompleted === true))
        .catch(() => { /* An unread completion state retains first-run navigation. */ });
    }
    return () => { active = false; };
  }, [userId, ownerCurrent, search, router]);
}
