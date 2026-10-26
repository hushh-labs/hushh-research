/**
 * The Profile pane is how /one/profile/world-model is presented: proxy.ts
 * redirects every Profile path to /one?profile_pane=1&profile_panel=<panel>.
 * A pane address naming the model must show the model, never the Profile root
 * menu and never a redirect back to the route (which proxy.ts sends back here).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeProfilePage } from "@/lib/capacitor/native-drawers";

const nativePresentation = vi.hoisted(() => ({ workspace: vi.fn() }));

const nav = vi.hoisted(() => ({
  query: "profile_pane=1&profile_panel=world-model",
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    forward: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/one",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(nav.query),
}));
const auth = vi.hoisted(() => ({
  userId: "owner-a",
  user: {
    uid: "owner-a",
    displayName: "",
    email: null,
    emailVerified: false,
    providerData: [],
    getIdToken: async () => "id-token",
  },
  loading: false,
  sessionVerificationRequired: false,
  phoneNumber: null,
  phoneNumberStatus: "missing",
  signOut: async () => undefined,
  startPhoneVerification: vi.fn().mockResolvedValue({ autoVerified: false }),
  confirmPhoneVerification: vi.fn(),
  confirmPhoneTransfer: vi.fn(),
  startPhoneReplacement: async () => undefined,
  confirmPhoneReplacement: async () => undefined,
}));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => auth }));
const vault = vi.hoisted(() => ({
  vaultKey: "key-a",
  vaultOwnerToken: "token-a",
  isVaultUnlocked: true,
  tokenExpiresAt: null,
  getVaultOwnerToken: () => "token-a",
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ personaState: null, refresh: async () => undefined }),
}));
// Keep the actual Profile entrypoint and hosting gate. Only replace the native
// bridge leaf: a closed Connectors body must not prevent Profile from mounting.
vi.mock("@/components/profile/native-profile-menu", () => ({
  NativeProfilePresentation: ({ workspace, children, onPayoutCapability, page, menu, phone }: {
    workspace?: { active: boolean; pages: readonly NativeProfilePage[] }; children: ReactNode; onPayoutCapability?: (available: boolean) => void;
    page?: { onClose?: () => unknown }; menu?: { onClose: () => unknown };
    phone?: { active: boolean; editor: (options: { native: boolean; onFallback: () => void }) => ReactNode };
  }) => {
    useEffect(() => { onPayoutCapability?.(true); }, [onPayoutCapability]);
    if (workspace?.active) nativePresentation.workspace(workspace.pages);
    return <><div role="dialog" aria-label="Native Profile" />
      <button onClick={() => page?.onClose?.()}>Page Close Profile</button>
      <button onClick={() => menu?.onClose()}>Menu Close Profile</button>
      {workspace && !workspace.active ? children : null}
      {phone?.active ? phone.editor({ native: false, onFallback: () => undefined }) : null}</>;
  },
}));

// The validated auth session and vault epoch are runtime singletons; here the
// session is the mocked owner above, current until the abort signal fires.
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/agent/agent-pkm-capture-runtime")
  >()),
  createAgentPkmCaptureGuard: ({
    signal,
    isEnabled,
  }: {
    signal: AbortSignal;
    isEnabled: () => boolean;
  }) => ({
    isCurrent: () => !signal.aborted && isEnabled(),
    assertCurrent: async () => {
      if (signal.aborted || !isEnabled()) throw new Error("stale");
    },
  }),
}));

import { ProfilePage } from "@/components/profile/profile-workspace-page";
import { WorldModelProvider } from "@/components/profile/world-model-provider";
import { WorldModelResearchService } from "@/lib/services/world-model-research-service";
import { WorldModelDecisionService } from "@/lib/services/world-model-decision-service";
import { VaultService } from "@/lib/services/vault-service";
import { StepProgressProvider } from "@/lib/progress/step-progress-context";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { ReferralService } from "@/lib/services/referral-service";

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionPrincipal({ firebaseUid: auth.user.uid, ownerId: auth.userId, accountGeneration: 0 });
  nav.query = "profile_pane=1&profile_panel=world-model";
  // Profile's own background reads (identity, vault, discoverability) answer
  // "not found"; this test is about what the pane shows, not those reads.
  window.history.replaceState(null, "", `/one?${nav.query}`);
  vi.spyOn(VaultService, "checkVault").mockResolvedValue(true);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  );
});

afterEach(() => {
  publishValidatedAuthSessionPrincipal(null);
  vi.restoreAllMocks();
});

function activeScreen() {
  return document.querySelector<HTMLElement>(
    '[data-profile-stack-active="true"]',
  );
}

describe("Profile pane: Personal World Model", () => {
  it("keeps both native Close paths locked until uncertain phone transfer settles", async () => {
    const { ApiError } = await import("@/lib/services/api-client");
    nav.query = "profile_pane=1&profile_panel=account&profile_detail=phone";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    const close = vi.fn();
    vi.spyOn(auth, "confirmPhoneVerification").mockRejectedValue(new ApiError("Review transfer", 409, { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" }));
    vi.spyOn(auth, "confirmPhoneTransfer").mockRejectedValueOnce(new ApiError("Check progress", 409, { code: "PHONE_TRANSFER_IN_PROGRESS" })).mockResolvedValueOnce(auth.user);
    render(<StepProgressProvider><ProfilePage presentation="native-page" nativeMenuOpen
      onNativeMenuClose={close} paneLocation={{ panel: "account", detail: "phone" }} /></StepProgressProvider>);
    const input = await screen.findByRole("textbox", { name: "Phone number" });
    fireEvent.change(input, { target: { value: "6505550101" } });
    fireEvent.submit(input.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } }); fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Use this number on this account" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone transfer" }));
    const progress = await screen.findByRole("button", { name: "Check transfer progress" });
    fireEvent.click(screen.getByRole("button", { name: "Page Close Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Menu Close Profile" }));
    expect(close).not.toHaveBeenCalled();
    expect(auth.startPhoneVerification).toHaveBeenCalledOnce();
    fireEvent.click(progress);
    await waitFor(() => expect(auth.confirmPhoneTransfer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check transfer progress" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Page Close Profile" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the complete information-access payment owner in the native Profile handoff", async () => {
    nav.query = "profile_pane=1&profile_panel=payouts";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    render(<StepProgressProvider><ProfilePage presentation="native-page"
      nativeMenuOpen paneLocation={{ panel: "payouts", detail: null }} /></StepProgressProvider>);
    await waitFor(() => expect(nativePresentation.workspace).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "payouts", sections:
        expect.arrayContaining([expect.objectContaining({ title: "Information access" })]),
      })]),
    ));
  });
  it("mounts native Profile independently of the closed Connectors hosting gate", async () => {
    nav.query = "profile_pane=1";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    render(<StepProgressProvider><ProfilePage presentation="native-page"
      nativeMenuOpen paneLocation={{ panel: null, detail: null }} /></StepProgressProvider>);
    expect(await screen.findByRole("dialog", { name: "Native Profile" })).toBeInTheDocument();
  });

  it("opens Invite friends in the existing Profile stack without leaving the workspace", async () => {
    nav.query = "profile_pane=1";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    vi.spyOn(ReferralService, "getSummary").mockResolvedValue({ joined_count: 2, qualified_count: 1,
      in_progress_count: 1, under_review_count: 0, required_active_minutes: 15,
      new_users_only: true, slug: "synthetic-invite", link: "https://example.test/r/synthetic-invite", referrals: [] });
    const view = render(<StepProgressProvider><ProfilePage presentation="pane"
      paneLocation={{ panel: null, detail: null }} /></StepProgressProvider>);
    fireEvent.click(within(activeScreen()!).getByRole("button", { name: "Invite friends" }));
    expect(window.location.pathname).toBe("/one");
    expect(new URLSearchParams(window.location.search).get("profile_pane")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("profile_panel")).toBe("referrals");
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(nav.router.replace).not.toHaveBeenCalled();
    nav.query = window.location.search.slice(1);
    view.rerender(<StepProgressProvider><ProfilePage presentation="pane"
      paneLocation={{ panel: "referrals", detail: null }} /></StepProgressProvider>);
    await waitFor(() => expect(activeScreen()?.dataset.profileStackScreen).toBe("panel:referrals"));
    expect(await within(activeScreen()!).findByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(activeScreen()!).getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Referrals" })).not.toBeInTheDocument();
  });
  it("does not replace an explicit Memory refresh with a late initialization response", async () => {
    nav.query = "profile_pane=1&profile_panel=my-data";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    const metadata = (label: string) => ({ ...PersonalKnowledgeModelService.emptyMetadata(auth.user.uid),
      domains: [{ key: "synthetic", displayName: label, attributeCount: 1, summary: {}, availableScopes: [], lastUpdated: null }] });
    let resolveInitial!: (value: ReturnType<typeof metadata>) => void;
    const initial = new Promise<ReturnType<typeof metadata>>(resolve => { resolveInitial = resolve; });
    const read = vi.spyOn(PersonalKnowledgeModelService, "getMetadata").mockImplementation((_id, force) =>
      force ? Promise.resolve(metadata("Fresh category")) : initial);
    vi.spyOn(ConsentCenterService, "getCenter").mockResolvedValue({ active_grants: [] } as never);
    render(<StepProgressProvider><ProfilePage presentation="pane" paneLocation={{ panel: "my-data", detail: null }} /></StepProgressProvider>);
    await waitFor(() => expect(read).toHaveBeenCalled());
    act(() => { window.dispatchEvent(new CustomEvent("pkm-domain-changed", { detail: { userId: auth.user.uid } })); });
    await waitFor(() => expect(within(activeScreen()!).getByText("Fresh category")).toBeInTheDocument());
    act(() => { resolveInitial(metadata("Stale category")); });
    // Let the intentionally deferred initialization settle without awaiting
    // unrelated live-resource effects in one global async React act scope.
    await initial;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(activeScreen()!).getByText("Fresh category")).toBeInTheDocument();
    expect(within(activeScreen()!).queryByText("Stale category")).not.toBeInTheDocument();
  });
  it.each(["domain:missing", "connection:missing"] as const)("retains a destination body when %s cannot resolve", detail => {
    nav.query = `profile_pane=1&profile_panel=my-data&profile_detail=${encodeURIComponent(detail)}`;
    window.history.replaceState(null, "", `/one?${nav.query}`);
    render(<StepProgressProvider><ProfilePage presentation="pane" paneLocation={{ panel: "my-data", detail }} /></StepProgressProvider>);
    expect(activeScreen()?.dataset.profileStackScreen).toBe(`detail:${detail}`);
    expect(within(activeScreen()!).getByRole("status")).toHaveTextContent(/Loading|Couldn’t load|no longer available/);
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
  it("renders the model in the pane instead of the Profile root menu", async () => {
    render(
      <ProfilePage
        presentation="pane"
        paneLocation={{ panel: "world-model", detail: null }}
      />,
    );
    await act(async () => {});
    const status = await screen.findByText("Checking your model…");
    // The visible stack screen is the model, holding its status region; the
    // Profile root menu is only the hidden screen behind it.
    const active = activeScreen();
    expect(active?.dataset.profileStackScreen).toBe("panel:world-model");
    expect(active).toContainElement(status);
    const row = status.closest("[data-testid='pwm-status-row']");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("status")).toHaveTextContent("This only takes a moment.");
    expect(within(active!).queryByText("Your account")).toBeNull();
    // The pane never sends the owner to the route proxy.ts redirects back here.
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("shows what the app-level provider prepares, though the pane is mounted beside it", async () => {
    vi.spyOn(WorldModelDecisionService, "load").mockResolvedValue({
      claims: {},
      saved: [],
      decidedKeys: new Set(),
    });
    const observe = vi
      .spyOn(WorldModelResearchService, "observe")
      .mockImplementation(({ onResult }) => {
        onResult({
          status: "pending",
          pkm_written: false,
          restart_required: false,
        });
        // The real service keeps watching while research runs; resolving
        // here would read as an exhausted watch, not a live one.
        return new Promise<void>(() => {});
      });
    vi.spyOn(WorldModelResearchService, "preferences").mockResolvedValue({
      enabled: true,
      email_enabled: true,
      consent_version: "pwm-native-v1",
      research_provider: "vertex_google_search",
    });
    // As in app/providers.tsx: the pane is a sibling of the provider's tree.
    render(
      <>
        <WorldModelProvider>
          <main />
        </WorldModelProvider>
        <ProfilePage
          presentation="pane"
          paneLocation={{ panel: "world-model", detail: null }}
        />
      </>,
    );
    const status = await screen.findByText("Preparing your model");
    expect(activeScreen()).toContainElement(status);
    // One reader prepares the model; the pane never starts its own.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Checking your model…")).toBeNull();
    // Never idle: the row says what is happening even before progress arrives.
    const row = status.closest("[data-testid='pwm-status-row']") as HTMLElement;
    expect(within(row).getByRole("status").textContent).not.toBe("");
    expect(within(activeScreen()!).getByTestId("pwm-progress-row")).toBeInTheDocument();
  });

  it("builds every card the way the Payouts pane does", async () => {
    vi.spyOn(WorldModelDecisionService, "load").mockResolvedValue({
      claims: {},
      saved: [],
      decidedKeys: new Set(),
    });
    vi.spyOn(WorldModelResearchService, "observe").mockImplementation(
      async ({ onResult }) => {
        onResult({ status: "pending", pkm_written: false, restart_required: false });
      },
    );
    vi.spyOn(WorldModelResearchService, "preferences").mockResolvedValue({
      enabled: true,
      email_enabled: true,
      consent_version: "pwm-native-v1",
      research_provider: "vertex_google_search",
    });
    render(
      <>
        <WorldModelProvider>
          <main />
        </WorldModelProvider>
        <ProfilePage
          presentation="pane"
          paneLocation={{ panel: "world-model", detail: null }}
        />
      </>,
    );
    await screen.findByText("Preparing your model");
    await screen.findByText("Research and email");
    const page = activeScreen()!.querySelector<HTMLElement>("[data-pwm-page]")!;
    const groups = within(page).getAllByTestId("settings-group");
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const group of groups) {
      // Compact density like Payouts, and only settings rows inside: no
      // hand-padded text blocks or lists of their own.
      expect(group).toHaveAttribute("data-settings-density", "compact");
      expect(group.querySelector(".px-4.py-3, .px-4.pb-3, ul.divide-y")).toBeNull();
      for (const row of group.querySelectorAll("[data-testid$='-row']"))
        expect(row).toHaveAttribute("data-settings-density", "compact");
    }
    // Notes outside the cards use the pane's note style.
    for (const note of page.querySelectorAll(".profile-account-note"))
      expect(note).toHaveAttribute("data-ui-role", "helper-text");
  });

  it("opens the model inside the pane from the Profile row", async () => {
    nav.query = "profile_pane=1";
    window.history.replaceState(null, "", `/one?${nav.query}`);
    render(
      <ProfilePage presentation="pane" paneLocation={{ panel: null, detail: null }} />,
    );
    await act(async () => {});
    const row = await within(activeScreen()!).findByText("Personal World Model");
    await act(async () => {
      row.click();
    });
    const params = new URLSearchParams(window.location.search);
    expect(window.location.pathname).toBe("/one");
    expect(params.get("profile_pane")).toBe("1");
    expect(params.get("profile_panel")).toBe("world-model");
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
});
