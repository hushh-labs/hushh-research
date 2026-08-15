import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  replace,
  migrateOnboardingBufferMock,
  acknowledgeOneSetupExitMock,
  vaultDialogOpenStates,
} = vi.hoisted(() => ({
  replace: vi.fn(),
  migrateOnboardingBufferMock: vi.fn(),
  acknowledgeOneSetupExitMock: vi.fn(),
  vaultDialogOpenStates: [] as boolean[],
}));

let vaultState = {
  vaultKey: null as string | null,
  vaultOwnerToken: null as string | null,
  isVaultUnlocked: false,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "local-first-user" } }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => vaultState,
}));

/**
 * Stands in for the real dialog, which renders nothing while `open` is false.
 * The marker is the honest signal that a vault surface was actually presented.
 */
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({
    open,
    onSuccess,
  }: {
    open: boolean;
    onSuccess: () => void;
  }) => {
    vaultDialogOpenStates.push(open);
    if (!open) return null;
    return (
      <div data-testid="vault-unlock-dialog">
        <button type="button" onClick={() => onSuccess()}>
          complete vault
        </button>
      </div>
    );
  },
}));

vi.mock("@/lib/services/onboarding-buffer-migration-service", () => ({
  migrateOnboardingBuffer: migrateOnboardingBufferMock,
}));

vi.mock("@/lib/services/one-setup-exit-service", () => ({
  acknowledgeOneSetupExit: acknowledgeOneSetupExitMock,
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => ({ oneRuntimeChoice: "hushh_managed" }),
    bootstrapState: vi.fn(async () => ({ oneRuntimeChoice: "hushh_managed" })),
    hasOneRuntimeChoice: () => true,
    // These tests are about the VAULT sequence, so both root prerequisites are
    // already satisfied. Without this the hub's exit gate blocks on the cloud step --
    // which is the gate working, but it is not what this file is exercising.
    hasOneCloudProject: () => true,
  },
}));

vi.mock("@/lib/onboarding/use-capability-setup-states", () => ({
  useCapabilitySetupStates: () => ({
    byId: {},
    isLoading: false,
    isEnriching: false,
  }),
}));

vi.mock("@/lib/onboarding/capability-setup-copy", () => ({
  CAPABILITY_SETUP_COPY: [],
}));

vi.mock("@/lib/onboarding/one-capabilities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOneSetupCapability: () => null,
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));

vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: () => undefined,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { ONE_HOME: "/one", ONE_SETUP_CLOUD: "/one/setup/cloud",
    ONE_SETUP_CONNECTIONS: "/one/setup/connections" },
  isOneSetupSurfaceRoute: () => false,
  normalizeInternalRouteHref: () => null,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppPageHeaderRegion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

vi.mock("@/components/app-ui/settings-ui", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/onboarding/setup/capability-setup-tile", () => ({
  CapabilitySetupTile: () => null,
  SetupNavigationTile: () => null,
}));

vi.mock("@/components/onboarding/setup/setup-completion-footer", () => ({
  SetupCompletionFooter: ({
    label,
    onComplete,
  }: {
    label: string;
    onComplete: () => void;
  }) => (
    <button type="button" data-testid="one-setup-master-ack" onClick={onComplete}>
      {label}
    </button>
  ),
}));

type StubButtonProps = {
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: string;
  effect?: string;
  size?: string;
  fullWidth?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
} & Record<string, unknown>;

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: (props: StubButtonProps) => {
    const {
      children,
      onClick,
      disabled,
      variant: _variant,
      effect: _effect,
      size: _size,
      fullWidth: _fullWidth,
      className: _className,
      type: _type,
      ...rest
    } = props;
    return (
      <button type="button" onClick={onClick} disabled={disabled} {...rest}>
        {children}
      </button>
    );
  },
}));

import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";

const FLAG = "NEXT_PUBLIC_ONBOARDING_LOCAL_FIRST_ENABLED";
const ORIGINAL_FLAG = process.env[FLAG];

function restoreFlag() {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env[FLAG];
  } else {
    process.env[FLAG] = ORIGINAL_FLAG;
  }
}

beforeEach(() => {
  vaultState = { vaultKey: null, vaultOwnerToken: null, isVaultUnlocked: false };
  vaultDialogOpenStates.length = 0;
  replace.mockReset();
  migrateOnboardingBufferMock.mockReset();
  migrateOnboardingBufferMock.mockResolvedValue({
    outcome: "pending_vault",
    acknowledgedIds: [],
    remainingIds: ["rec-1"],
  });
  acknowledgeOneSetupExitMock.mockReset();
  acknowledgeOneSetupExitMock.mockResolvedValue(undefined);
});

afterEach(() => {
  restoreFlag();
});

describe("flag OFF — onboarding is unchanged", () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it("goes straight from Finish setup to the vault invitation", async () => {
    render(<OneSetupHub />);

    fireEvent.click(screen.getByTestId("one-setup-master-ack"));

    await waitFor(() => {
      expect(screen.getByTestId("one-setup-vault-invitation")).toBeTruthy();
    });
    expect(screen.queryByTestId("one-setup-guided-connection")).toBeNull();
    expect(screen.queryByTestId("one-setup-vault-explainer")).toBeNull();
    expect(migrateOnboardingBufferMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("one-setup-vault-invitation-open"));
    await waitFor(() => {
      expect(screen.getByTestId("vault-unlock-dialog")).toBeTruthy();
    });
  });

  it("routes home on vault success without running any migration", async () => {
    render(<OneSetupHub />);

    fireEvent.click(screen.getByTestId("one-setup-master-ack"));
    await waitFor(() => screen.getByTestId("one-setup-vault-invitation"));
    fireEvent.click(screen.getByTestId("one-setup-vault-invitation-open"));
    await waitFor(() => screen.getByTestId("vault-unlock-dialog"));

    fireEvent.click(screen.getByText("complete vault"));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one");
    });
    expect(migrateOnboardingBufferMock).not.toHaveBeenCalled();
  });
});

describe("flag ON — vault is the last step, after the migration", () => {
  beforeEach(() => {
    process.env[FLAG] = "1";
  });

  it("shows one guided-connection screen instead of the vault invitation", async () => {
    render(<OneSetupHub />);

    fireEvent.click(screen.getByTestId("one-setup-master-ack"));

    await waitFor(() => {
      expect(screen.getByTestId("one-setup-guided-connection")).toBeTruthy();
    });
    expect(screen.queryByTestId("one-setup-vault-invitation")).toBeNull();
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
    // No readiness event cached, so the screen does not claim readiness.
    expect(screen.getByText("One last connection")).toBeTruthy();
  });

  it("names the private agent as ready once the feed has said so", async () => {
    CacheService.getInstance().set(
      CACHE_KEYS.FEED_LIST("local-first-user"),
      {
        items: [
          {
            id: "feed-1",
            source_domain: "consent",
            event_type: "personal_agent_ready",
            actor_label: null,
            metadata: {},
            read: false,
            created_at: "2026-08-01T00:00:00.000Z",
          },
        ],
        next_cursor: null,
        unread_count: 0,
      },
      60_000,
    );

    render(<OneSetupHub />);
    fireEvent.click(screen.getByTestId("one-setup-master-ack"));

    await waitFor(() => {
      expect(screen.getByText("Your private agent is ready")).toBeTruthy();
    });

    CacheService.getInstance().invalidate(
      CACHE_KEYS.FEED_LIST("local-first-user"),
    );
  });

  it("fires no vault surface until the migration pass has completed", async () => {
    let releaseMigration: (() => void) | null = null;
    migrateOnboardingBufferMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMigration = () =>
            resolve({
              outcome: "pending_vault",
              acknowledgedIds: [],
              remainingIds: ["rec-1"],
            });
        }),
    );

    render(<OneSetupHub />);
    fireEvent.click(screen.getByTestId("one-setup-master-ack"));
    await waitFor(() => screen.getByTestId("one-setup-guided-connection"));

    fireEvent.click(screen.getByTestId("one-setup-guided-connection-continue"));

    // Migration in flight: no vault surface, no explainer.
    await waitFor(() => {
      expect(migrateOnboardingBufferMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
    expect(screen.queryByTestId("one-setup-vault-explainer")).toBeNull();
    expect(vaultDialogOpenStates.some(Boolean)).toBe(false);

    releaseMigration?.();

    await waitFor(() => {
      expect(screen.getByTestId("one-setup-vault-explainer")).toBeTruthy();
    });
    // Still no vault surface — the explainers come first.
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
  });

  it("walks three explainer screens, one idea each, then opens the vault", async () => {
    render(<OneSetupHub />);
    fireEvent.click(screen.getByTestId("one-setup-master-ack"));
    await waitFor(() => screen.getByTestId("one-setup-guided-connection"));
    fireEvent.click(screen.getByTestId("one-setup-guided-connection-continue"));
    await waitFor(() => screen.getByTestId("one-setup-vault-explainer"));

    // 1 — what the vault is.
    expect(screen.getByTestId("one-setup-vault-explainer-what")).toBeTruthy();
    expect(screen.getByText("Your vault is a locked box")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));

    // 2 — why only they can open it.
    expect(screen.getByTestId("one-setup-vault-explainer-who")).toBeTruthy();
    expect(screen.getByText("Only you can open it")).toBeTruthy();
    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));

    // 3 — the honest expectation if they stop here.
    expect(screen.getByTestId("one-setup-vault-explainer-skip")).toBeTruthy();
    expect(screen.getByText("If you stop here, nothing is saved")).toBeTruthy();
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));
    await waitFor(() => {
      expect(screen.getByTestId("vault-unlock-dialog")).toBeTruthy();
    });
  });

  it("drains the buffer once the vault exists, then routes home", async () => {
    const { rerender } = render(<OneSetupHub />);
    fireEvent.click(screen.getByTestId("one-setup-master-ack"));
    await waitFor(() => screen.getByTestId("one-setup-guided-connection"));
    fireEvent.click(screen.getByTestId("one-setup-guided-connection-continue"));
    await waitFor(() => screen.getByTestId("one-setup-vault-explainer"));
    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));
    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));
    fireEvent.click(screen.getByTestId("one-setup-vault-explainer-next"));
    await waitFor(() => screen.getByTestId("vault-unlock-dialog"));

    // The pre-vault pass ran with no key, exactly as the sequence intends.
    expect(migrateOnboardingBufferMock).toHaveBeenCalledWith({
      userId: "local-first-user",
      vaultKey: null,
      vaultOwnerToken: null,
    });

    migrateOnboardingBufferMock.mockResolvedValue({
      outcome: "migrated",
      acknowledgedIds: ["rec-1"],
      remainingIds: [],
    });

    fireEvent.click(screen.getByText("complete vault"));
    await waitFor(() => screen.getByTestId("one-setup-buffer-handoff"));
    // The hub stays mounted: the key only arrives on the next render.
    expect(replace).not.toHaveBeenCalled();

    vaultState = {
      vaultKey: "ab".repeat(32),
      vaultOwnerToken: "owner-token",
      isVaultUnlocked: true,
    };
    rerender(<OneSetupHub />);

    await waitFor(() => {
      expect(migrateOnboardingBufferMock).toHaveBeenCalledWith({
        userId: "local-first-user",
        vaultKey: "ab".repeat(32),
        vaultOwnerToken: "owner-token",
      });
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one");
    });
  });
});
