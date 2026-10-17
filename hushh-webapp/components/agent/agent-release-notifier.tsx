"use client";

import { ReleaseNoticeDialog } from "@/components/app-ui/release-notice-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useAgentRuntimeState } from "@/lib/agent/agent-runtime-context";
import { useManagedReleaseNotice, usePodReleaseNotice, useReleaseNoticeController } from "@/lib/agent/use-release-notices";

/** App announcements and verified pod receipts share presentation, not authority. */
export function AgentReleaseNotifier() {
  const { userId, loading } = useAuth();
  const { hasVaultAccess, onboardingActive } = useAgentRuntimeState();
  const ownerId = !loading && hasVaultAccess && !onboardingActive ? userId ?? null : null;
  const controller = useReleaseNoticeController(ownerId);
  useManagedReleaseNotice(ownerId, controller.present);
  usePodReleaseNotice(ownerId, controller.present);
  return <ReleaseNoticeDialog notice={controller.notice} onPresented={controller.presented} onClose={controller.close} />;
}
