import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  owner: "owner-a" as string | null,
  ready: true,
  bootstrap: vi.fn(),
  status: vi.fn(),
  seen: new Set<string>(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: state.owner, loading: false }) }));
vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeState: () => ({ hasVaultAccess: state.ready, onboardingActive: false }),
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getPersonalAgentStatus: state.status } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: { bootstrapState: state.bootstrap, isSetupResolved: (s: { setupCompleted: boolean }) => s.setupCompleted },
}));
vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenRelease: async (owner: string, id: string) => state.seen.has(`${owner}:${id}`),
    markReleaseSeen: async (owner: string, id: string) => { state.seen.add(`${owner}:${id}`); },
  },
}));
vi.mock("@/components/app-ui/release-notice-dialog", () => ({
  ReleaseNoticeDialog: ({ notice, onPresented, onClose }: {
    notice: { title: string } | null; onPresented: () => void; onClose: () => void;
  }) => {
    useEffect(() => { if (notice) onPresented(); }, [notice, onPresented]);
    return notice ? <button onClick={onClose}>{notice.title}</button> : null;
  },
}));

import { AgentReleaseNotifier } from "@/components/agent/agent-release-notifier";
import { completedPodNotice, publishPodUpdateObservation } from "@/lib/agent/pod-update-notice";
import { currentManagedAppRelease } from "@/lib/agent/managed-app-release";

const digest = `sha256:${"a".repeat(64)}`;
const receipt = {
  installedReleaseVerified: true,
  installedRelease: { version: "2026.10-dev.9", imageDigest: digest },
  completedUpdate: {
    operationId: "operation-a", releaseId: "release-a", podIncarnation: "pod-a",
    imageDigest: digest, verifiedAt: "2026-10-07T00:00:00Z", version: "2026.10-dev.9",
  },
};

beforeEach(() => {
  state.owner = "owner-a";
  state.ready = true;
  state.seen.clear();
  state.bootstrap.mockReset().mockResolvedValue({ userId: "owner-a", setupCompleted: true, firstLoginAt: Date.parse("2026-09-01") });
  state.status.mockReset().mockResolvedValue({});
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dev.one.hushh.ai");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("Release notices", () => {
  it("shows existing owners once across sibling instances and refresh", async () => {
    const view = render(<><AgentReleaseNotifier /><AgentReleaseNotifier /></>);
    await screen.findByRole("button", { name: "What’s new in One" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(state.seen.size).toBe(1));
    view.unmount();
    render(<AgentReleaseNotifier />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([Date.parse("2026-10-08"), null])("does not give new or unknown accounts catch-up notices (%s)", async (firstLoginAt) => {
    state.bootstrap.mockResolvedValue({ userId: "owner-a", setupCompleted: true, firstLoginAt });
    render(<AgentReleaseNotifier />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button")).toBeNull();
    expect(state.seen.size).toBe(firstLoginAt === null ? 0 : 1);
  });

  it("uses the earlier server account date for legacy records with a repaired first-login date", async () => {
    state.bootstrap.mockResolvedValue({ userId: "owner-a", setupCompleted: true, firstLoginAt: Date.parse("2026-10-08"), createdAt: Date.parse("2026-09-01") });
    render(<AgentReleaseNotifier />);
    await screen.findByRole("button", { name: "What’s new in One" });
  });

  it("drops delayed evidence from a previous owner and waits for unlock", async () => {
    let finish!: (value: object) => void;
    state.bootstrap.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<AgentReleaseNotifier />);
    state.owner = "owner-b";
    state.ready = false;
    view.rerender(<AgentReleaseNotifier />);
    await act(async () => finish({ userId: "owner-a", setupCompleted: true, firstLoginAt: 1 }));
    publishPodUpdateObservation("owner-a", receipt);
    expect(screen.queryByRole("button")).toBeNull();
    expect(state.seen.size).toBe(0);
  });

  it("does not reopen a retired owner’s dialog when switching A to B to A", async () => {
    const view = render(<AgentReleaseNotifier />);
    await screen.findByRole("button", { name: "What’s new in One" });
    state.owner = "owner-b";
    state.ready = false;
    view.rerender(<AgentReleaseNotifier />);
    state.owner = "owner-a";
    state.ready = true;
    view.rerender(<AgentReleaseNotifier />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps verified pod completion independent of a newer offer", async () => {
    state.bootstrap.mockResolvedValue({ userId: "owner-a", setupCompleted: true, firstLoginAt: null });
    state.status.mockResolvedValue({ ...receipt, updateAvailable: true, updateVerified: false });
    render(<AgentReleaseNotifier />);
    await screen.findByRole("button", { name: "Your private agent is updated" });
    fireEvent.click(screen.getByRole("button"));
    await act(async () => publishPodUpdateObservation("owner-a", receipt));
    expect(screen.queryByRole("button")).toBeNull();
    expect(completedPodNotice({ ...receipt, installedReleaseVerified: false })).toBeNull();
    expect(completedPodNotice({ ...receipt, installedRelease: { version: "old", imageDigest: `sha256:${"b".repeat(64)}` } })).toBeNull();
  });

  it("cancels queued dialogs on unmount so they cannot retain a sibling tab lock", async () => {
    state.status.mockResolvedValue(receipt);
    const view = render(<AgentReleaseNotifier />);
    await screen.findByRole("button", { name: "What’s new in One" });
    view.unmount();
    state.bootstrap.mockResolvedValue({ userId: "owner-a", setupCompleted: true, firstLoginAt: null });
    render(<AgentReleaseNotifier />);
    await screen.findByRole("button", { name: "Your private agent is updated" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("does not advertise the dev announcement on UAT, production or an unknown origin", () => {
    for (const url of ["https://uat.one.hushh.ai", "https://one.hushh.ai", "https://dev.one.hushh.ai.attacker.invalid", "broken"]) {
      expect(currentManagedAppRelease(url)).toBeNull();
    }
  });
});
