"use client";

import { ReleaseNoticeDialog } from "@/components/app-ui/release-notice-dialog";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useAgentRuntimeState } from "@/lib/agent/agent-runtime-context";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { useManagedReleaseNotice, usePodReleaseNotice, useReleaseNoticeController } from "@/lib/agent/use-release-notices";

/** App announcements and verified pod receipts share presentation, not authority. */
export function AgentReleaseNotifier() {
  const { userId, loading } = useAuth();
  const { hasVaultAccess, onboardingActive } = useAgentRuntimeState();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "");
  // Cosmetic announcements wait while someone reviews consent or reads shared
  // information. The existing owner epoch retires queued work without marking it seen.
  const reviewingInformation = pathname === ROUTES.CONSENTS || pathname.startsWith("/people/");
  const ownerId = !loading && hasVaultAccess && !onboardingActive && !reviewingInformation ? userId ?? null : null;
  const controller = useReleaseNoticeController(ownerId);
  useManagedReleaseNotice(ownerId, controller.present);
  usePodReleaseNotice(ownerId, controller.present);
  return <ReleaseNoticeDialog notice={controller.notice} onPresented={controller.presented} onClose={controller.close} />;
}
