import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: /ria/profile hung forever on "Loading profile..." (UAT, 2026-08-08).
 *
 * The section redirected to /ria/onboarding whenever it believed no profile
 * existed, and the onboarding page redirected an established adviser straight
 * back. With a stale cached status against a correct persona the two bounced
 * ~1.3 times a second, silently, with no network traffic and no console error —
 * and the profile rendered its spinner under the same predicate that fired the
 * redirect, so the user saw an eternal spinner.
 *
 * The redirect must therefore be attempted at most once, and the screen must
 * end up on something actionable.
 */

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  useAuth: vi.fn(),
  usePersonaState: vi.fn(),
  refresh: vi.fn(),
  switchPersona: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  riaService: {
    deleteProfile: vi.fn(),
    updateProfile: vi.fn(),
    refreshLicenseProfile: vi.fn(),
    claimEmailStart: vi.fn(),
    claimEmailConfirm: vi.fn(),
    getDossier: vi.fn().mockResolvedValue(null),
    retryDossier: vi.fn(),
  },
  openKaiCommandBar: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}));

vi.mock("lucide-react", () => ({
  ArrowRight: () => <span />,
  CheckCircle2: () => <span />,
  ClipboardCheck: () => <span />,
  ExternalLink: () => <span />,
  Loader2: () => <span />,
  MessageCircle: () => <span />,
  Pencil: () => <span />,
  RotateCcw: () => <span />,
  ShieldCheck: () => <span />,
  Trash2: () => <span />,
}));

vi.mock("@/components/ria/profile/ria-location-map", () => ({
  RiaLocationMap: () => <div data-testid="ria-location-map" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-services", () => ({
  OnboardingStepServices: () => <div data-testid="step-services" />,
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaCompatibilityState: () => <div data-testid="ria-compat" />,
  isRiaVerified: (status?: string | null) =>
    ["active", "verified", "finra_verified"].includes(
      String(status || "").toLowerCase(),
    ),
}));

vi.mock("@/components/app-ui/settings-ui", () => ({
  SettingsDetailPanel: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="edit-panel">{children}</div> : null),
  SettingsGroup: ({
    children,
    testId = "manage-group",
  }: {
    children: React.ReactNode;
    testId?: string;
  }) => <div data-testid={testId}>{children}</div>,
  SettingsRow: ({
    title,
    onClick,
    testId,
  }: {
    title: React.ReactNode;
    onClick?: () => void;
    testId?: string;
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));
vi.mock("@/lib/services/ria-service", () => ({ RiaService: mocks.riaService }));
vi.mock("@/lib/services/ria-onboarding-draft-local-service", () => ({
  RiaOnboardingDraftLocalService: { clear: () => Promise.resolve() },
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onPersonaStateChanged: vi.fn() },
}));
vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    invalidateResourcePrefix: () => Promise.resolve(),
  },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: mocks.toast }));
vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { RIA_ONBOARDING: "/ria/onboarding", ONE_HOME: "/one" },
}));
vi.mock("@/lib/navigation/kai-command-bar-events", () => ({
  openKaiCommandBar: mocks.openKaiCommandBar,
}));

import { RiaProfileSection } from "@/components/ria/profile/ria-profile-section";

// The split brain: the persona says this adviser is established ("switch"),
// the (stale) status says the profile does not exist.
const SPLIT_BRAIN_STATUS = { exists: false };

function renderSection(status: unknown) {
  return render(
    <RiaProfileSection
      status={status as never}
      loading={false}
      onRefresh={vi.fn()}
    />,
  );
}

describe("RiaProfileSection redirect loop breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.useAuth.mockReturnValue({
      user: { uid: "u1", getIdToken: vi.fn().mockResolvedValue("tok") },
    });
    mocks.usePersonaState.mockReturnValue({
      riaCapability: "switch",
      loading: false,
      refreshing: false,
      refresh: mocks.refresh,
      switchPersona: mocks.switchPersona,
    });
    mocks.refresh.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects to onboarding at most once, even across re-renders", () => {
    const { rerender } = renderSection(SPLIT_BRAIN_STATUS);

    for (let i = 0; i < 5; i += 1) {
      rerender(
        <RiaProfileSection
          status={SPLIT_BRAIN_STATUS as never}
          loading={false}
          onRefresh={vi.fn()}
        />,
      );
    }

    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
    expect(mocks.routerReplace).toHaveBeenCalledWith("/ria/onboarding");
  });

  it("stops spinning and offers a way out when the redirect never lands", async () => {
    renderSection(SPLIT_BRAIN_STATUS);

    // Before the bound elapses the neutral skeleton is correct.
    expect(screen.queryByText("Loading profile...")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2000);

    await waitFor(() =>
      expect(screen.queryByText("Loading profile...")).toBeNull(),
    );
    expect(screen.getByTestId("ria-profile-missing-retry")).toBeTruthy();
    expect(screen.getByTestId("ria-profile-missing-setup")).toBeTruthy();
  });

  it("never redirects when the profile exists", () => {
    renderSection({ exists: true, verification_status: "submitted" });
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});
