/**
 * "Checking your agent home..." must end.
 *
 * It is a truthful sentence for a few seconds and a dead end after that. On
 * 2026-09-02 a returning person's session refresh stalled, the status call never
 * left the browser, and this line stayed on screen with nothing to click. Past
 * the ceiling the page must show an explicit status retry and must not offer a
 * new pod choice while existing placement is unknown.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import {
  ByocCloudSetupPage,
  CLOUD_CHECK_TIMEOUT_MS,
} from "@/components/connections/byoc-cloud-setup-page";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "uid-returning" }, loading: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => null,
    bootstrapState: () => new Promise(() => {}),
    hasOneCloudProject: () => false,
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
    suggestByocProject: vi.fn().mockResolvedValue(null),
    saveByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    selectSharedHosting: vi.fn(),
    beginByocAuthorize: vi.fn(),
  },
}));

vi.mock("@/components/connections/byoc-cloud-card", () => ({
  ByocCloudCard: () => <div data-testid="byoc-cloud-card">naming form</div>,
}));

vi.mock("@/components/onboarding/setup/setup-completion-footer", () => ({
  SetupCompletionFooter: () => null,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const mockStatus = vi.mocked(ApiService.getByocSetupStatus);
const mockAgentStatus = vi.mocked(ApiService.getPersonalAgentStatus);

describe("ByocCloudSetupPage — the checking ceiling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStatus.mockReset();
    mockAgentStatus.mockReset();
    mockAgentStatus.mockResolvedValue({ hostingMode: "shared" } as never);
    mockStatus.mockResolvedValue({ status: "none" } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops saying 'Checking' at the ceiling without offering a tier on unknown status", async () => {
    mockStatus.mockReturnValue(new Promise(() => {})); // the stalled session: never answers
    mockAgentStatus.mockReturnValue(new Promise(() => {}));
    render(<ByocCloudSetupPage />);

    expect(screen.getByTestId("byoc-cloud-checking")).toBeTruthy();
    expect(screen.queryByTestId("byoc-cloud-check-timed-out")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_CHECK_TIMEOUT_MS + 1);
    });

    expect(screen.queryByTestId("byoc-cloud-checking")).toBeNull();
    expect(screen.getByTestId("byoc-cloud-check-timed-out")).toBeTruthy();
    expect(screen.getByTestId("hosting-mode-unknown")).toBeTruthy();
    expect(screen.getByTestId("hosting-mode-refresh")).toBeTruthy();
    expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
  });

  it("never shows the note when the status arrives in time", async () => {
    mockStatus.mockResolvedValue({ status: "none" } as never);
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByTestId("byoc-cloud-checking")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_CHECK_TIMEOUT_MS + 1);
    });
    expect(screen.queryByTestId("byoc-cloud-check-timed-out")).toBeNull();
  });

  it("shows Shared as the no-pod default and keeps Hussh Pods gated", async () => {
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByTestId("shared-hosting-selected")).toBeTruthy();
    expect(screen.getByTestId("cloud-tier-own")).toBeTruthy();
    expect((screen.getByTestId("cloud-tier-hosted") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not a dedicated agent/i)).toBeTruthy();
  });

  it("keeps a provisioning assignment on its pending screen", async () => {
    mockAgentStatus.mockResolvedValue({ hostingMode: "pending" } as never);
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByTestId("hosting-mode-pending")).toBeTruthy();
    expect(screen.queryByTestId("byoc-reserved-project-deploy")).toBeNull();
    expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
  });

  it.each(["pending", "byoc"] as const)(
    "offers the saved project only for an unassigned %s BYOC reservation",
    async (hostingMode) => {
      mockAgentStatus.mockResolvedValue({
        hostingMode,
        state: "reserved",
        deploymentTarget: "user_gcp",
        cloudProject: "saved-owner-project",
      } as never);
      render(<ByocCloudSetupPage />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(screen.getByTestId("byoc-reserved-project-deploy")).toBeTruthy();
      expect(screen.getByText(/Finish setup in saved-owner-project/)).toBeTruthy();
      expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
    },
  );

  it("keeps a saved project closed when its setup job cannot be read", async () => {
    mockAgentStatus.mockResolvedValue({
      hostingMode: "byoc",
      state: "reserved",
      deploymentTarget: "user_gcp",
      cloudProject: "saved-owner-project",
    } as never);
    mockStatus.mockRejectedValue(new Error("setup store unavailable"));
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });

    expect(screen.getByTestId("byoc-reserved-project-unverified")).toBeTruthy();
    expect(screen.queryByTestId("byoc-reserved-project-deploy")).toBeNull();
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
  });

  it("never retries a failed job for a different saved project", async () => {
    mockAgentStatus.mockResolvedValue({
      hostingMode: "pending",
      state: "reserved",
      deploymentTarget: "user_gcp",
      cloudProject: "saved-owner-project",
    } as never);
    mockStatus.mockResolvedValue({
      status: "failed",
      projectId: "other-project",
      stale: false,
    } as never);
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByTestId("byoc-reserved-project-mismatch")).toBeTruthy();
    expect(screen.queryByTestId("byoc-setup-retry")).toBeNull();
  });

  it("does not offer a tier when placement lookup fails", async () => {
    mockAgentStatus.mockRejectedValue(new Error("status unavailable"));
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(screen.getByTestId("hosting-mode-unknown")).toBeTruthy();
    expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
  });
});
