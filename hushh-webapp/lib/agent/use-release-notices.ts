"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentManagedAppRelease, managedReleaseAudience, type ReleaseNotice } from "@/lib/agent/managed-app-release";
import { completedPodNotice, POD_UPDATE_OBSERVED_EVENT } from "@/lib/agent/pod-update-notice";
import { ApiService } from "@/lib/services/api-service";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { withOwnerPodSessionLock } from "@/lib/services/owner-pod-session-lock";

type PendingNotice = { close: () => void; presented: () => void };
type NoticeEpoch = { ownerId: string | null };

export function useReleaseNoticeController(ownerId: string | null) {
  const [shown, setShown] = useState<{ ownerId: string; notice: ReleaseNotice; epoch: NoticeEpoch } | null>(null);
  const epoch = useMemo(() => ({ ownerId }), [ownerId]);
  const lifecycle = useRef({ active: false, epoch });
  const pending = useRef<PendingNotice | null>(null);
  useEffect(() => {
    const lifetime = { active: true, epoch };
    lifecycle.current = lifetime;
    return () => { lifetime.active = false; pending.current?.close(); pending.current = null; };
  }, [epoch]);

  const present = useCallback(async (expectedOwner: string, notice: ReleaseNotice) => {
    const lifetime = lifecycle.current;
    const current = () => lifetime.active && lifecycle.current === lifetime && lifetime.epoch.ownerId === expectedOwner;
    // A distinct cosmetic lock never blocks pod admission; sibling tabs check
    // acknowledgement inside the lock. It is held until the dialog closes.
    await withOwnerPodSessionLock(`release-notice:${expectedOwner}`, async () => {
      if (!current() || await OnboardingLocalService.hasSeenRelease(expectedOwner, notice.id)) return;
      if (!current()) return;
      let acknowledgement = Promise.resolve();
      await new Promise<void>((resolve) => {
        pending.current = {
          close: resolve,
          presented: () => {
            if (current()) {
              acknowledgement = OnboardingLocalService.markReleaseSeen(expectedOwner, notice.id);
            }
          },
        };
        setShown({ ownerId: expectedOwner, notice, epoch: lifetime.epoch });
      });
      await acknowledgement;
    });
  }, []);
  const close = useCallback(() => { pending.current?.close(); pending.current = null; setShown(null); }, []);
  const presented = useCallback(() => { pending.current?.presented(); }, []);
  const notice = shown?.ownerId === ownerId && shown.epoch === epoch ? shown.notice : null;
  return { notice, present, close, presented };
}

type PresentNotice = ReturnType<typeof useReleaseNoticeController>["present"];

export function useManagedReleaseNotice(ownerId: string | null, present: PresentNotice) {
  useEffect(() => {
    const release = currentManagedAppRelease();
    if (!ownerId || !release) return;
    let cancelled = false;
    void PreVaultUserStateService.bootstrapState(ownerId).then(async (state) => {
      if (cancelled || state.userId !== ownerId || !PreVaultUserStateService.isSetupResolved(state)) return;
      const audience = managedReleaseAudience(state, release);
      if (audience === "new") await OnboardingLocalService.markReleaseSeen(ownerId, release.id);
      if (audience === "existing" && !cancelled) await present(ownerId, release);
    }).catch(() => { /* Missing account evidence suppresses a catch-up notice. */ });
    return () => { cancelled = true; };
  }, [ownerId, present]);
}

export function usePodReleaseNotice(ownerId: string | null, present: PresentNotice) {
  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    const abort = new AbortController();
    const show = (notice: ReleaseNotice | null) => {
      if (!cancelled && notice) void present(ownerId, notice).catch(() => undefined);
    };
    void ApiService.getPersonalAgentStatus({ signal: abort.signal })
      .then((status) => show(completedPodNotice(status))).catch(() => undefined);
    const observed = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerId: string; notice: ReleaseNotice }>).detail;
      if (detail?.ownerId === ownerId) show(detail.notice);
    };
    window.addEventListener(POD_UPDATE_OBSERVED_EVENT, observed);
    return () => {
      cancelled = true;
      abort.abort();
      window.removeEventListener(POD_UPDATE_OBSERVED_EVENT, observed);
    };
  }, [ownerId, present]);
}
