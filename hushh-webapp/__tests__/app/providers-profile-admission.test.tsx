import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

// Execute the real public Providers shell and Profile pane. Background bridges
// and unrelated chrome have no role in this session-admission regression.
const auth = { isAuthenticated: true, loading: false, sessionVerificationRequired: false, userId: "synthetic-owner" };
const query = new URLSearchParams("profile_pane=1&profile_panel=account");
const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const unrelated: Array<[string, string[]]> = [
  ["@/components/profile/living-memory-bridge", ["LivingMemoryBridge"]],
  ["@/lib/firebase", ["AuthProvider"]],
  ["@/components/connections/contact-invitation-session-provider", ["ContactInvitationSessionProvider"]],
  ["@/components/connections/azure-return-boot-recovery", ["AzureReturnBootRecovery"]],
  ["@/components/onboarding/initial-contacts-bridge", ["InitialContactsBridge"]],
  ["@/lib/progress/step-progress-context", ["StepProgressProvider"]],
  ["@/components/app-ui/step-progress-bar", ["StepProgressBar"]],
  ["@/lib/cache/cache-context", ["CacheProvider"]],
  ["@/components/consent/notification-provider", ["ConsentNotificationProvider"]],
  ["@/components/feed/authenticated-feed-stream", ["AuthenticatedFeedStream"]],
  ["@/components/agent/global-voice-action-handlers", ["GlobalVoiceActionHandlers"]],
  ["@/components/profile/profile-identity-voice-refresh", ["ProfileIdentityVoiceRefresh"]],
  ["@/components/agent/global-consent-action-handlers", ["GlobalConsentActionHandlers"]],
  ["@/components/profile/account-lifecycle-step-bridge", ["AccountLifecycleStepBridge"]],
  ["@/components/connections/native-private-google-connector-handoff", ["NativePrivateGoogleConnectorHandoff"]],
  ["@/components/consent/consent-sheet-controller", ["ConsentSheetProvider"]],
  ["@/components/app-ui/top-app-bar", ["AppTopShell"]],
  ["@/components/app-ui/native-workspace-seat", ["NativeWorkspaceSeat"]],
  ["@/components/app-ui/app-edge-back-gesture", ["AppEdgeBackGesture"]],
  ["@/components/app-ui/app-profile-edge-gesture", ["AppProfileEdgeGesture"]],
  ["@/components/app-ui/top-shell-route-swipe", ["TopShellRouteSwipe"]],
  ["@/lib/agent/agent-runtime-context", ["AgentRuntimeStateProvider"]],
  ["@/components/agent/siri-one-voice-handoff", ["SiriOneVoiceHandoff"]],
  ["@/components/agent/siri-one-request-handoff", ["SiriOneRequestHandoff"]],
  ["@/components/agent/siri-one-action-handoff", ["SiriOneActionHandoff"]],
  ["@/components/agent/siri-one-entity-index-publisher", ["SiriOneEntityIndexPublisher"]],
  ["@/components/agent/agent-voice-edge-glow", ["AgentVoiceEdgeGlow"]],
  ["@/components/one-location/onboarding/location-onboarding-interaction-surface", ["OneLocationInteractionSurfaceProvider"]],
  ["@/components/app-ui/foundation-public-ambient", ["FoundationPublicAmbient"]],
  ["@/components/agent/agent-owner-gate", ["AgentOwnerGate"]],
  ["@/lib/one-voice/readiness", ["OneVoiceReadinessProvider"]],
  ["@/components/app-ui/app-bottom-shell", ["AppBottomShell"]],
  ["@/components/agent/agent-dock", ["AgentDockProvider"]],
  ["@/components/app-ui/ambient-chrome-mask", ["AmbientChromeController"]],
  ["@/components/ui/sonner", ["Toaster"]],
  ["@/components/status-bar-manager", ["StatusBarManager"]],
  ["@/components/keyboard-inset-manager", ["KeyboardInsetManager"]],
  ["@/components/profile/world-model-provider", ["WorldModelProvider"]],
  ["@/components/onboarding/PostAuthOnboardingSyncBridge", ["PostAuthOnboardingSyncBridge"]],
  ["@/components/wallet-card/wallet-profile-bootstrap", ["WalletProfileBootstrap"]],
  ["@/components/onboarding/onboarding-journey-guard", ["OnboardingJourneyGuard"]],
  ["@/components/observability/route-observer", ["ObservabilityRouteObserver"]],
  ["@/components/one-location/location-bus-account-bridge", ["LocationBusAccountBridge"]],
  ["@/lib/persona/persona-context", ["PersonaProvider"]],
  ["@/components/app-ui/native-test-router", ["NativeTestRouter"]],
  ["@/components/ria/ria-surface-scope-sync", ["RiaSurfaceScopeSync"]],
  ["@/components/app-ui/native-test-bootstrap", ["NativeTestBootstrap"]],
  ["@/components/app-ui/native-test-route-status", ["NativeTestRouteStatus"]],
  ["@/components/app-ui/interaction-runtime", ["InteractionRuntime"]],
  ["@/components/agent/agent-app-notifiers", ["AgentAppNotifiers"]],
  ["@/components/app-ui/render-perf-probe", ["RenderPerfProbe"]],
  ["@/components/app-ui/render-perf-profiler", ["RenderPerfProfiler"]],
  ["@/components/app-ui/boot-surface", ["BootRouteCommitted"]],
];
for (const [module, names] of unrelated) {
  vi.doMock(module, () => Object.fromEntries(names.map(name => [name, passthrough])));
}
vi.doMock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.doMock("@/lib/vault/vault-context", () => ({ VaultProvider: passthrough, useVault: () => ({ isVaultUnlocked: true }) }));
vi.doMock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => query, useRouter: () => router }));
vi.doMock("@/components/profile/profile-workspace-page", () => ({ ProfilePage: () => <div>Protected Account pane</div> }));
vi.doMock("@/lib/navigation/use-deep-link-return", () => ({ useDeepLinkReturn: () => {} }));
vi.doMock("@/lib/navigation/android-back", () => ({ useAndroidBack: () => {} }));
vi.doMock("@/lib/navigation/use-scroll-reset", () => ({ useScrollReset: () => {} }));
vi.doMock("@/lib/navigation/web-history-back", () => ({ useWebHistoryBack: () => {} }));
vi.doMock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => false }));
vi.doMock("@/lib/capacitor/native-navigation", async (original) => ({
  ...await original<typeof import("@/lib/capacitor/native-navigation")>(),
  useNativeNavigationInstalled: () => false, useNativeNavigationScrollFollowing: () => false,
  useNativeNavigationBlocked: () => {}, nativeShellOverlayBlocked: () => false,
}));

it("@feature_account_deletion @trace_loop keeps a retained Account URL sealed throughout recovery and resumes only on active admission", async () => {
  const { Providers } = await import("@/app/providers");
  window.history.replaceState(null, "", "/?" + query);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const view = render(<Providers><div>Route content</div></Providers>);
  await screen.findByText("Protected Account pane");
  for (const loading of [true, false, false]) {
    auth.loading = loading;
    auth.sessionVerificationRequired = true;
    view.rerender(<Providers><div>Route content</div></Providers>);
    await act(async () => {});
    expect(screen.queryByText("Protected Account pane")).toBeNull();
    expect(window.location.search).toBe("?" + query);
  }
  expect(router.push).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
  auth.sessionVerificationRequired = false;
  view.rerender(<Providers><div>Route content</div></Providers>);
  await screen.findByText("Protected Account pane");
  view.unmount();
});
