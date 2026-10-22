import { resolveSearchScreen, searchTargetMatchesCurrentRoute } from "@/lib/search/search-route-context";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOfferableInSearch,
  KaiCommandPalette,
} from "@/components/kai/kai-command-palette";
import {
  getKaiActionById,
  listKaiActionsForSurface,
  searchKaiActions,
} from "@/lib/kai/actions/kai-action-gateway";
import {
  clearActionUsage,
  recordActionUse,
} from "@/lib/search/action-usage-memory";
import type { AppRuntimeState } from "@/lib/kai/actions/voice-types";

const mobile = vi.hoisted(() => ({ value: false }));
// CRM suggestions are offered only in builds where that existing feature is enabled.
vi.mock("@/lib/connected-systems/crm-product-availability", () => ({ isLocalCrmBuildEnabled: () => true }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobile.value,
}));

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => null,
  preloadTickerUniverse: vi.fn(async () => []),
  searchTickerUniverse: () => [],
  searchTickerUniverseRemote: vi.fn(async () => []),
}));

// Signed in, vault open, standing on Profile -- outside Finance, so the
// palette offers actions and One, never tickers.
const runtimeState: AppRuntimeState = {
  auth: { signed_in: true, user_id: "user_1" },
  vault: { unlocked: true, token_available: true, token_valid: true },
  route: { pathname: "/one/profile", screen: "profile_account", subview: null },
  runtime: {
    analysis_active: false,
    analysis_ticker: null,
    analysis_run_id: null,
    import_active: false,
    import_run_id: null,
    busy_operations: [],
  },
  portfolio: { has_portfolio_data: true },
  persona: {
    active: "investor",
    primary_nav: "investor",
    available: ["investor"],
    transition_target: null,
    ria_switch_available: false,
    ria_setup_available: false,
  },
  voice: {
    available: false,
    tts_playing: false,
    last_tool_name: null,
    last_ticker: null,
  },
};

function renderPalette(
  initialQuery: string,
  options: {
    state?: AppRuntimeState;
    userId?: string;
    surfaceMetadata?: { deadEnd?: { reason: string; remedyActionId: string } | null };
  } = {},
) {
  const onSelectAction = vi.fn();
  const onSubmitPrompt = vi.fn();
  render(
    <KaiCommandPalette
      open
      onOpenChange={vi.fn()}
      onSelectAction={onSelectAction}
      onSubmitPrompt={onSubmitPrompt}
      initialQuery={initialQuery}
      appRuntimeState={options.state ?? runtimeState}
      surfaceMetadata={options.surfaceMetadata}
      userId={options.userId ?? null}
    />,
  );
  return { onSelectAction, onSubmitPrompt };
}

function renderedLabels(): string[] {
  return Array.from(document.querySelectorAll("[cmdk-item]")).map(
    (item) => item.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  mobile.value = false;
});

afterEach(() => {
  cleanup();
});

describe("typed search on desktop", () => {
  it("runs the row the person arrowed to when they press Enter", () => {
    const { onSelectAction, onSubmitPrompt } = renderPalette("dashboard");
    const input = screen.getByPlaceholderText("Ask One or search");

    // Ask One is the top row; one step down is the best-matching command.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(onSelectAction).toHaveBeenCalledWith({
      actionId: "route.kai_dashboard",
      slots: undefined,
    });
  });

  it("runs an exact action name on Enter while the top row is untouched", () => {
    const { onSelectAction, onSubmitPrompt } = renderPalette("open profile");

    fireEvent.keyDown(screen.getByPlaceholderText("Ask One or search"), {
      key: "Enter",
    });

    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(onSelectAction).toHaveBeenCalledWith({
      actionId: "route.profile",
      slots: undefined,
    });
  });

  it("asks One when nothing typed names an action", () => {
    const { onSelectAction, onSubmitPrompt } = renderPalette(
      "how did my portfolio do this week",
    );

    fireEvent.keyDown(screen.getByPlaceholderText("Ask One or search"), {
      key: "Enter",
    });

    expect(onSelectAction).not.toHaveBeenCalled();
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      "how did my portfolio do this week",
    );
  });
});

describe("typed search on phones", () => {
  it("renders the same rows and asks One on submit", () => {
    mobile.value = true;
    const { onSubmitPrompt } = renderPalette("dashboard");

    expect(
      screen.getByRole("button", { name: /Open Portfolio Dashboard/ }),
    ).toBeTruthy();

    fireEvent.submit(
      screen.getByRole("searchbox", { name: "Search or ask One" }).closest("form")!,
    );
    expect(onSubmitPrompt).toHaveBeenCalledWith("dashboard");
  });
});

describe("habit in ranking (gateway, not Search's own catalog)", () => {
  it("adds to matches without letting an unmatched action in", () => {
    const plain = searchKaiActions({
      query: "dashboard",
      appRuntimeState: runtimeState,
      limit: 40,
    });
    const boosted = searchKaiActions({
      query: "dashboard",
      appRuntimeState: runtimeState,
      limit: 40,
      boost: () => 3,
    });

    expect(boosted.map((entry) => entry.action.action_id).sort()).toEqual(
      plain.map((entry) => entry.action.action_id).sort(),
    );
  });

  it("never lifts a familiar action above a clearly better match", () => {
    // The palette used to sort by habit alone, so anything used before
    // jumped above the action that actually answered the query.
    const results = searchKaiActions({
      query: "dashboard",
      appRuntimeState: runtimeState,
      boost: (actionId) => (actionId === "route.kai_dashboard" ? 0 : 3),
    });

    expect(results[0]?.action.action_id).toBe("route.kai_dashboard");
  });
});

describe("what search offers", () => {
  it.each(["payments", "add funds", "purchase balance"])("uses the authored payment alias %s", (query) => {
    const { onSelectAction } = renderPalette(query);
    fireEvent.keyDown(screen.getByPlaceholderText("Ask One or search"), { key: "Enter" });
    expect(onSelectAction).toHaveBeenCalledWith({actionId: "route.profile_payouts", slots: undefined});
  });

  it("keeps payment navigation blocked after sign-out", () => {
    const { onSelectAction } = renderPalette("link my bank", {
      state: {...runtimeState, auth: {signed_in: false, user_id: null}},
    });
    const label = getKaiActionById("route.profile_payouts")!.label;
    expect(screen.getByText(label).closest("[cmdk-item]")).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByPlaceholderText("Ask One or search"), {key: "Enter"});
    expect(onSelectAction).not.toHaveBeenCalled();
  });

  it("does not offer a client-specific destination without a selected client", () => {
    renderPalette("show client overview");
    expect(screen.queryByText(getKaiActionById("ria.client_workspace.open_overview_tab")!.label)).toBeNull();
  });

  it("leaves out actions only One itself can run", () => {
    for (const actionId of [
      "consent.chat.turn",
      "location.chat.turn",
      "wallet.reveal",
      "consent.request",
      "consent.deny",
      "consent.revoke",
    ]) {
      expect(isOfferableInSearch(getKaiActionById(actionId)!), actionId).toBe(
        false,
      );
    }
  });

  it("keeps destinations, including ones hidden from navigation", () => {
    for (const actionId of [
      "route.kai_portfolio_holdings",
      "location.open_ask",
      "route.one_connect",
      "vault.setup_open",
    ]) {
      expect(isOfferableInSearch(getKaiActionById(actionId)!), actionId).toBe(
        true,
      );
    }
  });
});

describe("idle suggestions", () => {
  // The home screen (/one) as reported on 2026-09-27: search offered agent
  // hand-offs, a chat-only widget and an action that needs a proposal id, none
  // of which a tap can run. The fix at the time was gateway-side filtering;
  // Search's own catalog carries the same guarantee structurally, since it
  // only ever lists destinations a tap can run.
  const homeState: AppRuntimeState = {
    ...runtimeState,
    route: { pathname: "/one", screen: "one_agents", subview: null },
  };

  afterEach(() => {
    clearActionUsage("user_1");
  });

  it("is the same curated list regardless of recorded usage", () => {
    // Recording usage of actions that were never in Search's catalog --
    // including agent-only ones -- must not promote them. Search's idle row
    // stopped personalizing when it stopped being gateway-derived.
    for (const actionId of [
      "wallet.reveal",
      "consent.request",
      "consent.chat.turn",
      "location.open_ask",
    ]) {
      recordActionUse("user_1", actionId);
    }

    renderPalette("", { state: homeState, userId: "user_1" });

    const labels = renderedLabels();
    expect(labels).toContain("Open Location");
    for (const label of [
      "Reveal a card",
      "Request someone's information",
      "Ask Consent (Nav)",
      "Ask for someone's location",
    ]) {
      expect(labels).not.toContain(label);
    }
  });

  it("leads with the current screen's dead-end remedy when one is set", () => {
    renderPalette("", {
      state: homeState,
      surfaceMetadata: {
        deadEnd: {
          reason: "Connect your wallet to see Hussh Coins.",
          remedyActionId: "route.one_wallet",
        },
      },
    });

    const labels = renderedLabels();
    expect(labels[0]).toBe(
      "Open WalletConnect your wallet to see Hussh Coins.",
    );
  });

  it("does not answer a typed query with an agent hand-off", () => {
    renderPalette("ask location", { state: homeState });

    expect(renderedLabels()).not.toContain("Ask Location");
  });
});


describe("contract-owned search route context", () => {
  it("derives the current screen from generated route contracts", () => {
    expect(resolveSearchScreen("/ria/picks?source=my&category=avoid", "app")).toBe("ria_picks");
    expect(resolveSearchScreen("/one/location?view=people", "app")).toBe("one_location");
    expect(searchTargetMatchesCurrentRoute("/ria/picks", "/ria/picks?returnTo=%2Fone")).toBe(true);
  });
  it.each([
    ["/one/messages", "one_messages", "route.messages_connections"],
    ["/one/wallet-card", "one_wallet_card", "route.wallet_profile_cards"],
    ["/one/connected-systems/customer-crm", "connected_systems", "route.connected_system_list"],
    ["/one/email", "email_agent", "route.mail_connections"],
    ["/one/puppy", "puppy_one", "route.puppy_agents"],
  ])("offers a working contextual route on current screen %s", (href, currentScreen, actionId) => {
    expect(resolveSearchScreen(href, "app")).toBe(currentScreen);
    const actions = listKaiActionsForSurface({ href, screen: currentScreen });
    expect(actions.some(action => action.action_id === actionId && isOfferableInSearch(action))).toBe(true);
  });

  it("recognizes RIA source and category independently, including authored defaults", () => {
    expect(searchTargetMatchesCurrentRoute("/ria/picks?source=my", "/ria/picks?source=my&category=avoid")).toBe(true);
    expect(searchTargetMatchesCurrentRoute("/ria/picks?category=avoid", "/ria/picks?source=my&category=avoid")).toBe(true);
    expect(searchTargetMatchesCurrentRoute("/ria/picks?source=kai", "/ria/picks?source=my&category=avoid")).toBe(false);
    expect(searchTargetMatchesCurrentRoute("/ria/picks?source=kai", "/ria/picks")).toBe(true);
    expect(searchTargetMatchesCurrentRoute("/ria/picks?category=top-picks", "/ria/picks")).toBe(true);
    expect(searchTargetMatchesCurrentRoute("/ria/picks", "/ria/picks?source=my")).toBe(false);
  });
});
