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
import FinanceOnboardingSetupPage from "@/app/one/setup/finance/page";
import { PortfolioPersona } from "@/components/kai/advisor/portfolio-persona";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const state = vi.hoisted(() => ({
  beacon: vi.fn((_props: { routeId: string; marker: string }) => null),
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
  sourceBack: undefined as (() => void) | undefined,
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
  NativeTestBeacon: state.beacon,
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
  KaiFlow: (props: {
    onSetupSourceSettled: typeof state.source;
    onSetupPersonaBack?: () => void;
  }) => {
    state.source = props.onSetupSourceSettled;
    state.sourceBack = props.onSetupPersonaBack;
    return <p>Real source workflow</p>;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.current = true;
  state.vaultLocked = false;
  state.source = null;
  state.sourceBack = undefined;
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

it("starts at the questionnaire and shows Plaid confirmation before automatic settlement", async () => {
  render(<FinanceOnboardingSetupPage />);
  expect(state.beacon.mock.calls.at(-1)?.[0]).toMatchObject({
    routeId: "/one/setup/finance",
    marker: "native-route-one-setup-finance",
  });
  expect(
    screen.getByRole("heading", { name: "Let’s build your financial persona" }),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Meet Finance" })).toBeNull();
  expect(state.ready).toBe(false);
  expect(state.blocked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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
    expect(state.finish).toHaveBeenCalledWith({ recordAttempt: false });
  } finally {
    vi.useRealTimers();
  }
});

it("saves the original three starter preferences before import without overwriting loss capacity", async () => {
  render(<FinanceOnboardingSetupPage />);
  expect(
    screen.getByRole("heading", { name: "Let’s build your financial persona" }),
  ).toBeVisible();
  act(() => {
    expect(unwindBackLayer("/one/setup/finance")).toBe(false);
  });
  expect(screen.getAllByRole("group").map((group) => group.querySelector("legend")?.textContent)).toEqual([
    "01How long will this stay invested?",
    "02Portfolio down 20%, what's your move?",
    "03Which feels more comfortable to you?",
  ]);
  for (const label of [
    "Less than 3 years",
    "Invest more at lower prices",
    "Larger swings for higher potential returns",
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Real source workflow")).toBeVisible();
  expect(state.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "owner",
      updates: {
        investment_horizon: "short_term",
        drawdown_response: "buy_more",
        volatility_preference: "large",
      },
    }),
  );
  expect(state.ready).toBe(false);
  expect(screen.getByText("Real source workflow")).toBeVisible();
  expect(state.sourceBack).toBeTypeOf("function");
  act(() => state.sourceBack?.());
  expect(screen.getByRole("heading", { name: "Let’s build your financial persona" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
});

it("offers no skip-all and only three tappable answers per question", () => {
  render(<FinanceOnboardingSetupPage />);
  expect(screen.queryByRole("button", { name: "Skip all" })).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  const short = screen.getByRole("button", { name: "Less than 3 years" });
  const medium = screen.getByRole("button", { name: "3–7 years" });
  fireEvent.click(short);
  expect(short).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(medium);
  expect(short).toHaveAttribute("aria-pressed", "false");
  expect(medium).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(medium);
  expect(medium).toHaveAttribute("aria-pressed", "false");
});

it("recovers the explicit completion screen from a verified persisted source callback", () => {
  state.resumed = true;
  render(<FinanceOnboardingSetupPage />);
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
  expect(state.beacon.mock.calls.at(-1)?.[0]).toMatchObject({
    routeId: "/one/setup/finance/import",
    marker: "native-route-one-setup-finance-import",
  });
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
