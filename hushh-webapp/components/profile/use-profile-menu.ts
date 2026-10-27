"use client";

import { useSharedExperienceRecovery } from "@/hooks/use-shared-experience-recovery";
import { profileMenuGroups } from "./profile-menu-model";
export { PROFILE_LABELS, type ProfileMenuActions } from "./profile-menu-model";

/** Client composition stays separate from the import-safe, shared menu roster. */
export function useProfileMenuGroups(developerToolsAvailable: boolean, ownerId: string | null | undefined) {
  return profileMenuGroups(developerToolsAvailable, useSharedExperienceRecovery(ownerId));
}
