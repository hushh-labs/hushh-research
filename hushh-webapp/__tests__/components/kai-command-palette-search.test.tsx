// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOfferableInSearch,
  KaiCommandPalette,
} from "@/components/kai/kai-command-palette";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
  searchKaiActions,
  searchKaiActionsSemantic,
} from "@/lib/voice/kai-action-gateway";
import {
  clearActionUsage,
  recordActionUse,
} from "@/lib/voice/action-usage-memory";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

const mobile = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobile.value,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-owner-token" }),
}));

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  getTickerUniverseSnapshot: () => null,
  preloadTickerUniverse: vi.fn(async () => []),
  searchTickerUniverse: () => [],
  searchTickerUniverseRemote: vi.fn(async () => []),
}));

vi.mock("@/lib/voice/kai-action-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/kai-action-gateway")>()),
  searchKaiActionsSemantic: vi.fn(async () => []),
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
  options: { state?: AppRuntimeState; userId?: string } = {},
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
  vi.mocked(searchKaiActionsSemantic).mockResolvedValue([]);
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

  it("lists related-by-meaning results after the wording matches", async () => {
    const consents = getKaiActionById("route.consents")!;
    vi.mocked(searchKaiActionsSemantic).mockImplementation(async ({ query }) =>
      query === "dashboard"
        ? [
            {
              action: consents,
              availability: evaluateKaiActionAvailability({
                action: consents,
                appRuntimeState: runtimeState,
              }),
            },
          ]
        : [],
    );

    renderPalette("dashboard");

    // No shared letters with "dashboard": cmdk's own fuzzy filter used to
    // drop rows like this before anyone saw them.
    await waitFor(() =>
      expect(renderedLabels()).toContain("Open Consent Center"),
    );
    const labels = renderedLabels();
    expect(labels.indexOf("Open Portfolio Dashboard")).toBeLessThan(
      labels.indexOf("Open Consent Center"),
    );
    expect(labels.at(-1)).toBe("Open Consent Center");
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

describe("habit in ranking", () => {
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
  // The home screen (/one) as reported on 2026-09-27: search offered agent
  // hand-offs, a chat-only widget and an action that needs a proposal id, none
  // of which a tap can run.
  const homeState: AppRuntimeState = {
    ...runtimeState,
    route: { pathname: "/one", screen: "one_agents", subview: null },
  };

  afterEach(() => {
    clearActionUsage("user_1");
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

  it("does not bring agent-only actions back as habits", () => {
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
    expect(labels).toContain("Ask for someone's location");
    for (const label of [
      "Reveal a card",
      "Request someone's information",
      "Ask Consent (Nav)",
      "Ask Location",
    ]) {
      expect(labels).not.toContain(label);
    }
  });

  it("does not answer a typed query with an agent hand-off", () => {
    renderPalette("ask location", { state: homeState });

    expect(renderedLabels()).not.toContain("Ask Location");
  });
});
