/**
 * OnboardingDismissStore - Zustand store for a "soft" (not remembered)
 * capability dismiss, shared between the dashboard setup tile and the
 * capability list screen it opens.
 *
 * ZERO PERSISTENCE: no sessionStorage, no localStorage. A soft dismiss is
 * meant to last only this session -- on reload it should come back, exactly
 * like every other Zustand store in this app that models session-scoped-only
 * state (see kai-session-store.ts). A *permanent* dismiss ("remember my
 * choice" checked) never touches this store -- it goes straight to
 * PreVaultUserStateService.syncDeclinedCapabilities, the same durable path
 * today's decline already uses.
 */

import { create } from "zustand";

interface OnboardingDismissState {
  /** Capability ids soft-dismissed this session only. */
  sessionDismissedIds: Set<string>;
  dismissForSession: (capabilityId: string) => void;
  undoSessionDismiss: (capabilityId: string) => void;
  isSessionDismissed: (capabilityId: string) => boolean;
}

export const useOnboardingDismissStore = create<OnboardingDismissState>(
  (set, get) => ({
    sessionDismissedIds: new Set<string>(),
    dismissForSession: (capabilityId) =>
      set((state) => ({
        sessionDismissedIds: new Set(state.sessionDismissedIds).add(
          capabilityId,
        ),
      })),
    undoSessionDismiss: (capabilityId) =>
      set((state) => {
        const next = new Set(state.sessionDismissedIds);
        next.delete(capabilityId);
        return { sessionDismissedIds: next };
      }),
    isSessionDismissed: (capabilityId) =>
      get().sessionDismissedIds.has(capabilityId),
  }),
);
