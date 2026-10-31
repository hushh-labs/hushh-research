/**
 * "Checking your agent home..." must end.
 *
 * It is a truthful sentence for a few seconds and a dead end after that. On
 * 2026-09-02 a returning person's session refresh stalled, the status call never
 * left the browser, and this line stayed on screen with nothing to click. Past
 * the ceiling the page must show an explicit status retry and must not offer a
 * new pod choice while existing placement is unknown.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import {
  ByocCloudSetupPage,
  CLOUD_CHECK_TIMEOUT_MS,
} from "@/components/connections/byoc-cloud-setup-page";

const fixture = vi.hoisted(() => ({ user: { uid: "uid-returning" }, savedHosting: false, completed: false, search: "", replace: vi.fn() }));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: fixture.user, loading: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: fixture.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(fixture.search),
}));
vi.mock("@/lib/utils/browser-navigation", async (original) => ({
  ...(await original<object>()), requestInternalAppNavigation: () => false,
}));

vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => fixture.savedHosting ? { setupCompleted: fixture.completed } : null,
    bootstrapState: () => new Promise(() => {}),
    hasOneCloudProject: () => fixture.savedHosting,
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
  SetupCompletionFooter: ({ disabled, onComplete, label }: { disabled: boolean; onComplete: () => void; label: string }) => <button disabled={disabled} onClick={onComplete}>{label}</button>,
}));
vi.mock("@/components/connections/gemini-runtime-configuration-page", () => ({
  GeminiRuntimeConfigurationPage: ({ onSetupReadyChange }: { onSetupReadyChange: (ready: boolean) => void }) => <button onClick={() => onSetupReadyChange(true)}>Save AI access</button>,
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
    fixture.user = { uid: "uid-returning" };
    fixture.savedHosting = false;
    fixture.search = ""; fixture.completed = false;
    fixture.replace.mockReset();
    publishValidatedAuthSessionPrincipal({ firebaseUid: fixture.user.uid, ownerId: fixture.user.uid, accountGeneration: 0 });
    mockStatus.mockReset();
    mockAgentStatus.mockReset();
    vi.mocked(ApiService.selectSharedHosting).mockReset();
    vi.mocked(ApiService.beginByocAuthorize).mockReset();
    mockAgentStatus.mockResolvedValue({ featureEnabled: true, hostingMode: "shared" } as never);
    mockStatus.mockResolvedValue({ status: "none" } as never);
  });
  afterEach(() => {
    publishValidatedAuthSessionOwner(null);
    vi.useRealTimers();
  });

  it.each([false, undefined])("keeps Shared usable and refuses new cloud setup when availability is %s", async (featureEnabled) => {
    mockAgentStatus.mockResolvedValue({ hostingMode: "unplaced", featureEnabled });
    vi.mocked(ApiService.selectSharedHosting).mockResolvedValue({ hostingMode: "shared" } as never);
    fixture.search = "intent=migrate";
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId("cloud-tier-own")).toBeDisabled();
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
    expect(screen.getByTestId("byoc-setup-unavailable")).toHaveTextContent("continue with Hussh Shared");
    fireEvent.click(screen.getByTestId("cloud-tier-shared-option"));
    await act(async () => { fireEvent.click(screen.getByTestId("cloud-tier-shared")); });
    expect(ApiService.selectSharedHosting).toHaveBeenCalledOnce();
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });

  it("preserves a reserved cloud and disables deployment when setup is paused", async () => {
    mockAgentStatus.mockResolvedValue({ hostingMode: "pending", state: "reserved", deploymentTarget: "user_gcp", cloudProject: "saved-project", featureEnabled: false });
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId("byoc-reserved-project")).toHaveTextContent("saved-project");
    expect(screen.getByTestId("byoc-reserved-project-deploy")).toBeDisabled();
    expect(screen.getByTestId("byoc-setup-unavailable")).toHaveTextContent("saved progress is kept");
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
  });

  it("finishes a replacement owner's verified hosting without confusing its Firebase identity", async () => {
    const ownerId = "acct_" + "b".repeat(32);
    publishValidatedAuthSessionPrincipal({ firebaseUid: fixture.user.uid, ownerId, accountGeneration: 1 });
    fixture.savedHosting = true;
    fixture.search = "?return_to=%2Fone%2Fprofile%2Fhosting";
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole("button", { name: "Save AI access" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish agent setup" }));
    expect(fixture.replace).toHaveBeenLastCalledWith("/one/profile/hosting");
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
  });

  it.each(["", "?return_to=%2Fone%2Fprofile%2Fhosting"])("returns verified setup to its entry destination (%s)", async (search) => {
    fixture.search = search;
    fixture.savedHosting = true;
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole("button", { name: "Save AI access" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish agent setup" }));
    expect(fixture.replace).toHaveBeenCalledWith(search ? "/one/profile/hosting" : "/one/setup");
  });

  it("canonicalizes completed direct entries for shell and native Back without changing setup", async () => {
    fixture.savedHosting = true; fixture.completed = true;
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fixture.replace).toHaveBeenCalledWith("/one/setup/cloud?return_to=%2Fone%2Fprofile%2Fhosting&from=%2Fone%2Fprofile%2Fhosting");
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
  });

  it("keeps management Back and Finish aligned for a return-only Hosting link", async () => {
    fixture.savedHosting = true;
    fixture.search = "?return_to=%2Fone%2Fprofile%2Fhosting";
    render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fixture.replace).toHaveBeenCalledWith("/one/setup/cloud?return_to=%2Fone%2Fprofile%2Fhosting&from=%2Fone%2Fprofile%2Fhosting");
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save AI access" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish agent setup" }));
    expect(fixture.replace).toHaveBeenLastCalledWith("/one/profile/hosting");
  });

  it("keeps AI behind verified hosting and drops both proofs on an owner switch", async () => {
    const view = render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.queryByRole("button", { name: "Save AI access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish agent setup" })).toBeNull();
    fixture.savedHosting = true;
    view.unmount();
    const readyView = render(<ByocCloudSetupPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Finish agent setup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save AI access" }));
    expect(screen.getByRole("button", { name: "Finish agent setup" })).toBeEnabled();
    fixture.user = { uid: "different-owner" };
    fixture.savedHosting = false;
    publishValidatedAuthSessionPrincipal({ firebaseUid: fixture.user.uid, ownerId: fixture.user.uid, accountGeneration: 0 });
    mockAgentStatus.mockReturnValue(new Promise(() => {}));
    readyView.rerender(<ByocCloudSetupPage />);
    expect(screen.queryByRole("button", { name: "Save AI access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish agent setup" })).toBeNull();
    expect(fixture.replace).not.toHaveBeenCalled();
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
    mockAgentStatus.mockResolvedValue({ featureEnabled: true, hostingMode: "pending" } as never);
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
        featureEnabled: true, hostingMode,
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
      featureEnabled: true, hostingMode: "byoc",
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
      featureEnabled: true, hostingMode: "pending",
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
