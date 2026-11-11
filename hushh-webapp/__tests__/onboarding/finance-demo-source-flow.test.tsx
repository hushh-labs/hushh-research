import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import type { KaiPreferences } from "@/lib/services/kai-profile-service";
import { beforeEach, expect, it, vi } from "vitest";
import { FinanceImportOnboardingSetupClient } from "@/app/one/setup/finance/import/finance-import-onboarding-setup-client";
import { PortfolioPersona } from "@/components/kai/advisor/portfolio-persona";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const state = vi.hoisted(() => ({
  finish: vi.fn(),
  bootstrap: vi.fn(),
  sync: vi.fn(),
  savePreferences: vi.fn(),
  getProfile: vi.fn(),
  vaultLocked: false,
  current: true,
  ready: false,
  resumed: false,
  blocked: true,
  source: null as
    | null
    | ((
        source: "plaid" | "statement" | "later",
        attempt?: string,
      ) => Promise<boolean>),
  journey: {
    onboardingActiveCapability: "finance",
    onboardingCallbackAttemptId: "attempt",
    onboardingJourneyUpdatedAt: "revision",
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/one/setup/finance",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: {}, userId: "owner", loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultOwnerToken: "memory-only",
    getVaultKey: () => null,
  }),
}));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({
  useFinanceShareContext: () => ({
    capture: () =>
      state.vaultLocked
        ? null
        : {
            userId: "owner",
            vaultKey: "synthetic",
            vaultOwnerToken: "synthetic",
            isCurrent: () => state.current,
          },
  }),
}));
vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: {
    savePreferences: state.savePreferences,
    getProfile: state.getProfile,
  },
}));
vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: () => ({ userId: "owner", generation: 1 }),
  isValidatedAuthSessionOwnerCurrent: () => state.current,
}));
vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));
vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: () => <p>Preparing</p>,
  useSetupCapabilityCoordinator: (options: {
    isOperationallyReady: boolean;
    settlementBlocked: boolean;
  }) => {
    state.ready = options.isOperationallyReady;
    state.blocked = options.settlementBlocked;
    return {
      isReady: true,
      isSettling: false,
      isInitialSetup: true,
      operationallyReady: options.isOperationallyReady || state.resumed,
      finish: state.finish,
    };
  },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: state.bootstrap,
    syncOnboardingJourney: state.sync,
    isSetupResolved: () => false,
  },
}));
vi.mock("@/components/kai/kai-flow", () => ({
  KaiFlow: (props: { onSetupSourceSettled: typeof state.source }) => {
    state.source = props.onSetupSourceSettled;
    return <p>Real source workflow</p>;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.current = true;
  state.vaultLocked = false;
  state.source = null;
  state.resumed = false;
  state.bootstrap.mockResolvedValue(state.journey);
  state.sync.mockResolvedValue(undefined);
  state.finish.mockResolvedValue({ status: "succeeded" });
  state.savePreferences.mockImplementation(
    async ({ updates, beforeEffect }) => {
      await beforeEffect();
      return { preferences: updates };
    },
  );
});

it("keeps the demo local and shows Plaid confirmation before automatic settlement", async () => {
  render(<FinanceImportOnboardingSetupClient showIntroduction />);
  expect(
    screen.getByRole("heading", { name: "Follow the market." }),
  ).toBeTruthy();
  expect(state.ready).toBe(false);
  expect(state.blocked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  for (const choice of screen.getAllByRole("radio", { name: "I’m not sure yet" })) {
    fireEvent.click(choice);
  }
  fireEvent.click(screen.getByRole("button", { name: "Save persona" }));
  expect(await screen.findByText("Real source workflow")).toBeTruthy();
  expect(state.bootstrap).not.toHaveBeenCalled();
  await act(async () => {
    expect(await state.source!("plaid", "wrong-attempt")).toBe(false);
  });
  expect(state.sync).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    await act(async () => {
      expect(await state.source!("plaid", "attempt")).toBe(true);
    });
    expect(screen.getByRole("heading", { name: "Account connected" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Continuing setup");
    expect(state.ready).toBe(true);
    expect(state.blocked).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1499));
    expect(state.finish).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(state.finish).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("saves the persona before import and keeps risk comfort separate from near-term needs", async () => {
  render(<FinanceImportOnboardingSetupClient showIntroduction />);
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  expect(
    screen.getByRole("heading", { name: "Let’s build your financial persona" }),
  ).toBeVisible();
  act(() => {
    expect(unwindBackLayer("/one/setup/finance")).toBe(true);
  });
  expect(
    screen.getByRole("heading", { name: "Follow the market." }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  for (const label of [
    "Less than 3 years",
    "Consider investing more if my plan still fits",
    "Lose 30% or gain 35%",
    "I’d probably need to sell to cover bills",
  ]) {
    fireEvent.click(screen.getByRole("radio", { name: label }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Save persona" }));
  expect(await screen.findByText("Real source workflow")).toBeVisible();
  expect(state.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "owner",
      updates: {
        investment_horizon: "short_term",
        drawdown_response: "buy_more",
        volatility_preference: "large",
        loss_capacity: "essentials",
      },
    }),
  );
  expect(state.ready).toBe(false);
  expect(screen.getByText("Real source workflow")).toBeVisible();
});

it("skips unanswered persona questions and continues to import with a locked vault", () => {
  state.vaultLocked = true;
  state.bootstrap.mockResolvedValue({ ...state.journey, hasVault: true });
  render(<FinanceImportOnboardingSetupClient showIntroduction />);
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  fireEvent.click(screen.getByRole("radio", { name: "Less than 3 years" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
  expect(screen.getByText("Real source workflow")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.bootstrap).not.toHaveBeenCalled();
  expect(state.savePreferences).not.toHaveBeenCalled();
});

it("recovers the explicit completion screen from a verified persisted source callback", () => {
  state.resumed = true;
  render(<FinanceImportOnboardingSetupClient showIntroduction />);
  expect(screen.getByRole("heading", { name: "You're all set" })).toBeTruthy();
  expect(screen.queryByText("Real source workflow")).toBeNull();
  expect(state.blocked).toBe(false);
  expect(state.finish).not.toHaveBeenCalled();
});


it("does not show completion or mutate the journey when the owner retires during the read", async () => {
  let resolve!: (value: typeof state.journey) => void;
  state.bootstrap.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<FinanceImportOnboardingSetupClient />);
  let result!: Promise<boolean>;
  act(() => {
    result = state.source!("later");
  });
  await waitFor(() => expect(state.bootstrap).toHaveBeenCalledOnce());
  state.current = false;
  await act(async () => {
    resolve(state.journey);
    expect(await result).toBe(false);
  });
  expect(state.sync).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "You're all set" })).toBeNull();
});

it("opens a single 13-question assessment directly and updates the saved badge", async () => {
  const starter = {
    investment_horizon: "long_term",
    drawdown_response: "reduce",
    volatility_preference: "small",
    loss_capacity: "flexible",
  } as KaiPreferences;
  state.savePreferences.mockImplementation(async ({ updates, beforeEffect }) => {
    await beforeEffect();
    return { preferences: { ...starter, ...updates } };
  });
  const context = {
    userId: "owner",
    vaultKey: "synthetic",
    vaultOwnerToken: "synthetic",
    getIdToken: async () => "synthetic",
    isCurrent: () => state.current,
  };
  const onSaved = vi.fn();
  function Fixture() {
    const [preferences, setPreferences] = useState(starter);
    return <PortfolioPersona context={context} preferences={preferences} onSaved={(value) => {
      setPreferences(value);
      onSaved(value);
    }} />;
  }
  render(<Fixture />);
  expect(screen.getByText("Careful")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refine persona" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("progressbar", { name: "Assessment answers" })).toHaveAttribute("aria-valuenow", "0");
  expect(screen.queryByRole("button", { name: "Open detailed assessment" })).toBeNull();
  for (let index = 0; index < 13; index++) {
    expect(screen.getByText(`Question ${index + 1} of 13`)).toBeVisible();
    fireEvent.click(screen.getAllByRole("radio")[index < 8 ? 2 : 0]);
    fireEvent.click(
      screen.getByRole("button", {
        name: index === 12 ? "Save assessment" : "Continue",
      }),
    );
  }
  expect(
    await screen.findByRole("heading", { name: "Your investing persona" }),
  ).toBeVisible();
  expect(
    screen.getByText("One will look first at the money you may need soon."),
  ).toBeVisible();
  expect(state.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({
      updates: {
        detailed_assessment_v1: [...Array(8).fill(2), ...Array(5).fill(0)],
      },
    }),
  );
  expect(onSaved).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Back to analysis" }));
  expect(within(screen.getByRole("button", { name: "Refine persona" }).parentElement!).getByText("Growth-oriented")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refine persona" }));
  expect(screen.getAllByRole("radio")[2]).toBeChecked();
});
