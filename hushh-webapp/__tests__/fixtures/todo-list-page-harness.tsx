import { vi } from "vitest";
import type { ReactNode } from "react";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import type { CapabilityRead } from "@/lib/services/todo-capability-sources";

const mocks = vi.hoisted(() => ({
  user: { uid: "todo-owner", getIdToken: vi.fn() },
  unlocked: true,
  actionables: [] as FeedActionable[],
  feedError: null as string | null,
  feedLoading: false,
  retryFeed: vi.fn(),
  pendingKyc: null as { count: number; workflowId: string } | null,
  extraReads: [] as CapabilityRead[],
  sourceError: false,
  retrySources: vi.fn(),
  events: [
    {
      id: "calendar-event-1",
      title: "Review the plan",
      start: { date: "2026-10-10" },
    },
  ],
}));

export { mocks };

vi.mock("@/lib/todos/use-todo-capability-sources", () => ({ useTodoCapabilitySources: () => ({ reads: mocks.extraReads, loading: false, error: mocks.sourceError, refresh: mocks.retrySources }) }));
vi.mock("@/lib/feed/use-feed-actionables", () => ({
  useFeedActionables: ({ enabled }: { enabled: boolean }) => ({
    actionables: enabled ? mocks.actionables : [],
    error: mocks.feedError,
    loading: mocks.feedLoading,
    progressError: null,
    progressLoading: false,
    retry: mocks.retryFeed,
  }),
}));
vi.mock("@/lib/feed/use-feed-briefing", () => ({
  useFeedBriefing: ({ enabled }: { enabled: boolean }) => ({
    pendingKyc: enabled ? mocks.pendingKyc : null, kycLoading: false, kycError: false, retryKyc: async () => {},
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: mocks.unlocked,
    vaultKey: "test-vault-key",
    vaultOwnerToken: "test-owner-token",
  }),
}));

vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({
  useCalendarConnectionStatus: () => ({ connected: true, loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({
  useTodoUpcomingEvents: () => ({ events: mocks.events, loaded: true, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  AppPageHeaderRegion: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  AppPageContentRegion: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainData: vi.fn() },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: vi.fn(), error: vi.fn() },
}));
