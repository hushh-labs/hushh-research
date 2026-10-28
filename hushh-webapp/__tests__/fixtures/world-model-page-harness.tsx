import { act } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import type { PwmProgress, PwmValidatedFact } from "@/lib/services/world-model-research-service";
import { memoryOf } from "./world-model-review";

const mock = vi.hoisted(() => ({
  research: {} as Record<string, unknown>,
  /** The signed-in account, as the Account pane sees it. */
  auth: {
    user: { uid: "owner-a", displayName: "Alice" } as Record<string, unknown>,
    phoneNumber: null as string | null,
  },
  claimable: false,
  load: vi.fn(),
  confirm: vi.fn(),
  reject: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mock.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/one/profile/world-model",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mock.auth.user,
    userId: (mock.auth.user?.uid as string | undefined) ?? null,
    phoneNumber: mock.auth.phoneNumber,
    loading: false,
    sessionVerificationRequired: false,
  }),
}));
// The shared idle clock, driven by hand: the test moves Date and wakes readers.
const clock = vi.hoisted(() => ({
  intervals: [] as number[],
  listeners: new Set<() => void>(),
  tick() {
    for (const listener of this.listeners) listener();
  },
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: (intervalMs: number) => {
    clock.intervals.push(intervalMs);
    return useSyncExternalStore(
      (listener) => {
        clock.listeners.add(listener);
        return () => clock.listeners.delete(listener);
      },
      () => Date.now(),
      () => Date.now(),
    );
  },
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "key-a",
    vaultOwnerToken: "token-a",
    isVaultUnlocked: true,
    tokenExpiresAt: null,
  }),
}));
vi.mock("@/components/profile/world-model-provider", () => ({
  useWorldModelResearch: () => mock.research,
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", () => ({
  createAgentPkmCaptureGuard: ({ isEnabled }: { isEnabled: () => boolean }) => ({
    isCurrent: () => isEnabled(),
    assertCurrent: async () => {
      if (!isEnabled()) throw new Error("stale");
    },
  }),
}));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({
  usePkmDomainChangeRevision: () => 0,
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({ MARKDOWN_MEMORY_DOMAIN: "one_memory" }));
vi.mock("@/components/agent/profile-research-card", () => ({
  ProfileResearchCard: () => null,
}));
vi.mock("@/components/profile/world-model-claim-invitation", () => ({
  WorldModelClaimInvitation: ({ onClaimed }: { onClaimed?: () => void }) =>
    mock.claimable ? <button onClick={onClaimed}>Claim invitation</button> : null,
}));
vi.mock("@/components/profile/world-model-sources", () => ({
  WorldModelSources: ({ onResearchPublicProfiles, initialUrls, discovery, onRefresh }: { onResearchPublicProfiles?: (urls: readonly string[]) => void; initialUrls?: readonly string[]; discovery?: boolean; onRefresh?: () => void }) => <>
    <p>Claimed preview</p>
    {initialUrls ? <p data-testid="public-leads">{initialUrls.join("\n")}</p> : null}
    {onResearchPublicProfiles ? <button onClick={() => onResearchPublicProfiles(initialUrls ?? ["https://github.com/example-owner"])}>{discovery ? "Research optional public links" : "Research these profiles"}</button> : null}
    {onRefresh ? <button onClick={onRefresh}>Update my model</button> : null}
  </>,
}));
vi.mock("@/lib/services/world-model-decision-service", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/services/world-model-decision-service")>()),
  WorldModelDecisionService: {
    load: mock.load,
    confirm: mock.confirm,
    reject: mock.reject,
    edit: mock.edit,
    remove: mock.remove,
  },
}));

export function research(
  result: unknown,
  preferences = { enabled: true, email_enabled: true },
  live: Partial<{
    progress: PwmProgress | null;
    validatedFacts: PwmValidatedFact[];
    retrying: boolean;
    live: boolean;
    lastActivityAt: number | null;
    /** When a named wait ends, anchored by the store when the answer arrived. */
    retryAt: number | null;
  }> = {},
) {
  mock.research = {
    mounted: true,
    result,
    preferences: { ...preferences, consent_version: "pwm-native-v1", research_provider: "vertex_google_search" },
    failed: false,
    progress: null,
    validatedFacts: [],
    retrying: false,
    live: true,
    lastActivityAt: null,
    retryAt: null,
    reload: vi.fn(),
    refresh: vi.fn(),
    ...live,
  };
}

/** Moves the clock forward and wakes every reader of it. */
export function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
  act(() => clock.tick());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
  mock.claimable = false;
  mock.auth.user = { uid: "owner-a", displayName: "Alice" };
  mock.auth.phoneNumber = null;
  clock.intervals.length = 0;
  mock.load.mockResolvedValue(memoryOf());
});

afterEach(() => {
  vi.useRealTimers();
});


export { mock, clock };
