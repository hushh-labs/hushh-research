import { configure } from "@testing-library/react";
import { vi } from "vitest";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { useChatOnboardingSession } from "@/lib/agent/chat-onboarding/use-chat-onboarding";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { ApiService } from "@/lib/services/api-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const fixture = vi.hoisted(() => {
  const user = { uid: "owner", email: "owner@example.com", displayName: "Owner", getIdToken: async () => "test-id-token" };
  const tokenAccess = { available: true };
  return {
    tokenAccess,
    captureReady: false,
    nameOnboarding: false,
    auth: { user, loading: false, sessionVerificationRequired: false },
    vault: { isVaultUnlocked: true, vaultKey: "12".repeat(32), vaultOwnerToken: "test-owner-token", tokenExpiresAt: Date.now() + 3600000, getVaultOwnerToken: (): string | null => tokenAccess.available ? "test-owner-token" : null },
    persona: { activePersona: "investor", primaryNavPersona: "investor", personaTransitionTarget: null, riaSetupAvailable: false, riaSwitchAvailable: false, riaOnboardingStatus: null, switchPersona: vi.fn() },
    onboarding: { turns: [], shownTurns: new Map(), shownTurnTimes: new Map(), captureComposerText: () => false, dailyTip: null },
    memory: { text: "", domains: [], totalAttributes: 0, updatedAt: null },
    router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
    search: new URLSearchParams(),
    gmail: { status: null, loadingStatus: false, presentation: {} },
  };
});
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ ...fixture.auth, userId: fixture.auth.user.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => fixture.vault }));
vi.mock("@/lib/persona/persona-context", () => ({ usePersonaState: () => fixture.persona }));
vi.mock("@/lib/agent/chat-onboarding/use-chat-onboarding", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/agent/chat-onboarding/use-chat-onboarding")>();
  return { ...actual, useChatOnboarding: (input: Parameters<typeof actual.useChatOnboarding>[0]) =>
    fixture.nameOnboarding ? actual.useChatOnboarding(input) : fixture.onboarding };
});
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: vi.fn() } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: {
  syncOneChatOnboarding: vi.fn(async () => ({})),
} }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => fixture.gmail }));
vi.mock("@/lib/navigation/use-root-chat-deferred-ready", () => ({ useRootChatDeferredReady: () => true }));
vi.mock("@/lib/one-voice/readiness", () => ({ useOneVoiceLiveEnabled: () => false }));
vi.mock("@/hooks/use-effective-avatar-url", () => ({ useEffectiveAvatarUrl: () => null }));
vi.mock("@/lib/agent/use-one-display-name", () => ({ useOneDisplayName: () => "One" }));
vi.mock("@/lib/services/model-preference-service", () => ({ ModelPreferenceService: { get: async () => ({ choices: [], effective_model: "test" }) } }));
vi.mock("@/lib/agent/use-entry-welcome", () => ({ useEntryWelcome: () => null }));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async importOriginal => { const actual = await importOriginal<typeof import("@/lib/agent/agent-pkm-capture-runtime")>(); return { ...actual, isAgentPkmProcessingReady: (...args: Parameters<typeof actual.isAgentPkmProcessingReady>) => fixture.captureReady && actual.isAgentPkmProcessingReady(...args) }; });
vi.mock("@/lib/agent/agent-pkm-memory", async importOriginal => ({ ...await importOriginal<object>(), loadAgentPkmContext: async () => fixture.memory, peekAgentPkmContext: () => fixture.memory, warmAgentPkmContext: async () => fixture.memory }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => fixture.search, useRouter: () => fixture.router }));



export { fixture };

export function resetCalendarChatFixture() {
  configure({ asyncUtilTimeout: 5000 });
  useOneConversationSession.getState().clearSession();
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({}));
  fixture.captureReady = false;
  fixture.tokenAccess.available = true;
  fixture.nameOnboarding = false;
  useChatOnboardingSession.getState().reset(null);
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockReset().mockResolvedValue({ success: true, saveState: "saved" } as never);
  fixture.vault.isVaultUnlocked = true;
  fixture.auth.user.uid = "owner";
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  vi.spyOn(GoogleCalendarService, "status").mockResolvedValue({ connected: true, google_email: "owner@example.com", access_level: "manage" } as never);
  vi.spyOn(ApiService, "getPendingConsents").mockResolvedValue({ pending: [] } as never);
  // The owner-aware facade owns routing; this suite supplies its stream port.
  vi.spyOn(ApiService, "agentChatRequest").mockImplementation((path, init, streaming) =>
    streaming ? ApiService.apiFetchStream(path, init) : Promise.resolve(Response.json({})));
  vi.spyOn(ApiService, "listAgentChatConversations").mockResolvedValue(Response.json({ conversations: [] }));
  vi.spyOn(ApiService, "getAgentChatHistory").mockResolvedValue(Response.json({ messages: [] }));
}
