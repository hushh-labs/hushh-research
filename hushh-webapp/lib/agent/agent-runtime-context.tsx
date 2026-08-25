"use client";

// Shared agent active-state context (single source of truth).
//
// Before this provider, the full AppRuntimeState was assembled and trapped
// inside AgentChatWorkspace, so the agent bar (which renders separately on
// every route, including the marketing "/" intro) could not see auth, vault,
// route, persona, or runtime state. This context lifts that assembly up so the
// bar and the chat workspace read the exact same state, and adds the derived
// signals the consolidated onboarding agent needs: the access tier and the
// active voice mode.
//
// Security posture: this context only describes state. It never carries vault
// keys or owner tokens. Realtime and STT remain tool-less regardless of tier;
// only typed chat (which separately holds the vault owner token) touches data.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import {
  resolveOnboardingCapabilityForRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import {
  readVoicePreferences,
  subscribeVoicePreferences,
  type OneVoicePreferencesState,
} from "@/lib/agent/voice-preferences";
import type { Persona } from "@/lib/services/ria-service";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import {
  buildOneVoiceContextSnapshot,
  type OneVoiceContextSnapshot,
} from "@/lib/voice/screen-context-builder";
import { useVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import {
  buildMorphyAxSnapshot,
  resolveMorphyAxPresentation,
  toOneVoiceContextSnapshot,
  type MorphyAxPresentationState,
  type MorphyAxSnapshotV1,
} from "@/lib/morphy-ax";
import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";
import { useLocalOnboardingHandlerRevision } from "@/lib/agent/local-onboarding-actions";
import {
  deriveVoiceCapabilityState,
  type VoiceCapabilityStateV1,
} from "@/lib/voice/capability-projection";

// The access tier the agent should operate at. This is what drives how the
// bar presents itself and which persona the backend should compose.
//   - anon_onboarding: not signed in, inside the onboarding / intro flow ("/")
//   - anon_browsing:   not signed in, browsing a public surface
//   - signed_locked:   signed in, vault locked (no fresh owner token)
//   - signed_unlocked: signed in, vault unlocked with a fresh owner token
export type AgentAccessTier =
  | "anon_onboarding"
  | "anon_browsing"
  | "signed_locked"
  | "signed_unlocked";

// The agent bar can be in one of these interaction modes at a time.
//   - idle:     resting, no live channel
//   - ambient:  visual-only affordance (no capture, no socket)
//   - stt:      browser/STT dictation turn (tool-less)
//   - realtime: Gemini Live conversational session (tool-less)
//   - chat:     typed chat workspace is the active channel (vault-backed)
export type AgentVoiceMode = "idle" | "ambient" | "stt" | "realtime" | "chat";

export type AgentRuntimeState = {
  /** The full app runtime snapshot consumed by the voice/chat planner. */
  appRuntimeState: AppRuntimeState;
  /** Derived access tier used to shape bar UX and backend persona. */
  tier: AgentAccessTier;
  /** True when the user is inside the onboarding / intro flow. */
  onboardingActive: boolean;
  /** True on the marketing root route ("/"). */
  isHomeRoute: boolean;
  /** True when vault is unlocked AND a fresh owner token is available. */
  hasVaultAccess: boolean;
  /** The active persona (investor / ria). */
  activePersona: Persona;
  /** Normalized current screen id derived from the route. */
  screen: string;
  /** Redacted One Voice snapshot safe for realtime prompt shaping. */
  oneVoiceContextSnapshot: OneVoiceContextSnapshot;
  /** Redacted lifecycle and mounted-control state for action discovery. */
  capabilityState: VoiceCapabilityStateV1;
  /** Pure, redacted Agent Experience snapshot; never an action authority. */
  morphyAxSnapshot: MorphyAxSnapshotV1;
  /** Shared presentation posture derived from the existing voice FSM. */
  morphyAxPresentation: MorphyAxPresentationState;
  /** False keeps the compatibility path authoritative during rollout. */
  morphyAxEnabled: boolean;
};

const AgentRuntimeStateContext = createContext<AgentRuntimeState | null>(null);

function deriveTier(params: {
  signedIn: boolean;
  hasVaultAccess: boolean;
  onboardingActive: boolean;
  isHomeRoute: boolean;
}): AgentAccessTier {
  const { signedIn, hasVaultAccess, onboardingActive, isHomeRoute } = params;
  if (signedIn) {
    return hasVaultAccess ? "signed_unlocked" : "signed_locked";
  }
  return onboardingActive || isHomeRoute ? "anon_onboarding" : "anon_browsing";
}

function computeHasPortfolioData(uid: string | null | undefined): boolean {
  if (!uid) return false;
  const cache = CacheService.getInstance();
  const cachedPortfolio =
    cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(uid)) ??
    cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(uid, "financial"));
  const nestedPortfolio =
    cachedPortfolio?.portfolio &&
    typeof cachedPortfolio.portfolio === "object" &&
    !Array.isArray(cachedPortfolio.portfolio)
      ? (cachedPortfolio.portfolio as Record<string, unknown>)
      : null;
  const holdings =
    (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
    (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
    [];
  return holdings.length > 0;
}

function resolveOnboardingPhase(params: {
  path: string;
  signedIn: boolean;
  setupResolved: boolean;
}): OneVoiceContextSnapshot["onboarding"]["phase"] {
  if (!params.signedIn) return "anonymous_auth";
  if (params.path === ROUTES.PHONE_MANDATE) return "phone_required";
  if (params.path === ROUTES.ONE_SETUP) return "setup_hub";
  if (params.path.startsWith(`${ROUTES.ONE_SETUP}/`)) return "capability_setup";
  return params.setupResolved ? "root_completion" : "setup_hub";
}

export function AgentRuntimeStateProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // This subscription is the runtime bridge between a route-local rendered
  // control and One's redacted snapshot. It carries authored metadata only;
  // no DOM inference or second action registry is involved.
  const surfaceMetadata = useVoiceSurfaceMetadata();
  const localHandlerRevision = useLocalOnboardingHandlerRevision();
  // App Router is the query-state authority. This provider already lives under
  // the root Suspense boundary, so subscribing here does not affect static
  // export. Never wrap History: Next owns its insertion-effect settlement and
  // native post-auth routing must not acquire a second route publisher.
  const routeQuery = searchParams.toString();
  const { user } = useAuth();
  const {
    isVaultUnlocked,
    vaultOwnerToken,
    tokenExpiresAt,
  } = useVault();
  const {
    activePersona,
    primaryNavPersona,
    personaTransitionTarget,
    riaSetupAvailable,
    riaSwitchAvailable,
  } = usePersonaState();
  const analysisParams = useKaiSession((state) => state.analysisParams);
  const busyOperations = useKaiSession((state) => state.busyOperations);

  const voiceActive = useAgentVoiceState((state) => state.active);
  const voiceStatus = useAgentVoiceState((state) => state.status);
  const oneVoiceState = useAgentVoiceState((state) => state.oneVoiceState);
  const lastVoiceTransition = useAgentVoiceState((state) => state.lastTransition);

  const uid = user?.uid ?? null;
  const signedIn = Boolean(uid);
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const hasVaultAccess = Boolean(isVaultUnlocked && vaultOwnerToken && tokenIsFresh);

  const path = pathname ?? "";
  const pathnameWithQuery = routeQuery ? `${path}?${routeQuery}` : path;
  const routeInfo = useMemo(
    () => deriveVoiceRouteScreen(path, routeQuery),
    [path, routeQuery]
  );

  const isHomeRoute = path === ROUTES.HOME;
  const onboardingActive = useMemo(() => {
    const chrome = getKaiChromeState(path);
    return (
      chrome.useOnboardingChrome ||
      isHomeRoute ||
      path === ROUTES.GETTING_STARTED ||
      path === ROUTES.LOGIN ||
      path === ROUTES.PHONE_MANDATE ||
      path === ROUTES.ONE_SETUP ||
      path.startsWith(`${ROUTES.ONE_SETUP}/`)
    );
  }, [path, isHomeRoute]);

  const [preVaultState, setPreVaultState] = useState<PreVaultUserState | null>(null);
  useEffect(() => {
    if (!uid) {
      setPreVaultState(null);
      return;
    }
    let active = true;
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(uid);
    const refreshFromCache = () => {
      const cached = cache.get<PreVaultUserState>(cacheKey);
      if (active && cached) setPreVaultState(cached);
    };
    const loadPreVaultState = () => {
      void PreVaultUserStateService.bootstrapState(uid)
        .then((state) => {
          if (active) setPreVaultState(state);
        })
        .catch(() => {
          if (active) setPreVaultState(null);
        });
    };
    const isGmailRoute =
      path.startsWith("/one/gmail") ||
      path.startsWith("/one/setup/gmail") ||
      path.startsWith("/one/email");
    let cancelIdle: (() => void) | null = null;
    if (isGmailRoute && typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        const requestIdle = window.requestIdleCallback as (
          callback: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number;
        const cancel = window.cancelIdleCallback as (handle: number) => void;
        const handle = requestIdle(loadPreVaultState, { timeout: 4_000 });
        cancelIdle = () => cancel(handle);
      } else {
        const timeout = globalThis.setTimeout(loadPreVaultState, 1_000);
        cancelIdle = () => globalThis.clearTimeout(timeout);
      }
    } else {
      loadPreVaultState();
    }
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "set" && event.key === cacheKey) {
        refreshFromCache();
        return;
      }
      if (
        event.type === "clear" ||
        (event.type === "invalidate" && event.keys.includes(cacheKey)) ||
        (event.type === "invalidate_user" && event.userId === uid)
      ) {
        void PreVaultUserStateService.bootstrapState(uid)
          .then((state) => {
            if (active) setPreVaultState(state);
          })
          .catch(() => undefined);
      }
    });
    return () => {
      active = false;
      cancelIdle?.();
      unsubscribe();
    };
  }, [path, uid]);

  // hasPortfolioData mirrors the cache-subscribed computation that previously
  // lived only inside the chat workspace, so the shared state stays in sync as
  // portfolio data is imported or invalidated.
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  useEffect(() => {
    if (!uid) {
      setHasPortfolioData(false);
      return;
    }
    const cache = CacheService.getInstance();
    const recompute = () => setHasPortfolioData(computeHasPortfolioData(uid));
    recompute();
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === "set" ||
        event.type === "invalidate" ||
        event.type === "invalidate_user" ||
        event.type === "clear"
      ) {
        recompute();
      }
    });
    return () => unsubscribe();
  }, [uid]);

  const [voicePreferences, setVoicePreferences] = useState<OneVoicePreferencesState>(
    () => readVoicePreferences(uid),
  );
  useEffect(() => {
    setVoicePreferences(readVoicePreferences(uid));
    if (!uid) return;
    return subscribeVoicePreferences(uid, setVoicePreferences);
  }, [uid]);

  const availablePersonas = useMemo(() => {
    const personas = new Set<Persona>([activePersona]);
    personas.add("investor");
    if (riaSwitchAvailable) personas.add("ria");
    personas.add(primaryNavPersona);
    return Array.from(personas);
  }, [activePersona, primaryNavPersona, riaSwitchAvailable]);

  const activeAnalysisTicker = useMemo(() => {
    const ticker = analysisParams?.ticker;
    return typeof ticker === "string" && ticker.trim() ? ticker.trim() : null;
  }, [analysisParams?.ticker]);

  const appRuntimeState = useMemo<AppRuntimeState>(
    () => ({
      auth: {
        signed_in: signedIn,
        user_id: uid,
      },
      vault: {
        unlocked: isVaultUnlocked,
        token_available: Boolean(vaultOwnerToken),
        token_valid: tokenIsFresh,
      },
      route: {
        pathname: pathnameWithQuery,
        screen: routeInfo.screen,
        subview: routeInfo.subview ?? null,
      },
      runtime: {
        analysis_active:
          Boolean(busyOperations["stock_analysis_active"]) ||
          Boolean(busyOperations["stock_analysis_stream"]),
        analysis_ticker: activeAnalysisTicker,
        analysis_run_id: null,
        import_active: Boolean(busyOperations["portfolio_import_stream"]),
        import_run_id: null,
        busy_operations: Object.keys(busyOperations).filter((key) => busyOperations[key]),
      },
      portfolio: {
        has_portfolio_data: hasPortfolioData,
      },
      persona: {
        active: activePersona,
        primary_nav: primaryNavPersona,
        available: availablePersonas,
        transition_target: personaTransitionTarget,
        ria_switch_available: riaSwitchAvailable,
        ria_setup_available: riaSetupAvailable,
      },
      voice: {
        available: voiceActive,
        tts_playing: voiceStatus === "speaking",
        last_tool_name: null,
        last_ticker: null,
      },
    }),
    [
      activeAnalysisTicker,
      activePersona,
      availablePersonas,
      busyOperations,
      hasPortfolioData,
      isVaultUnlocked,
      pathnameWithQuery,
      personaTransitionTarget,
      primaryNavPersona,
      riaSetupAvailable,
      riaSwitchAvailable,
      routeInfo.screen,
      routeInfo.subview,
      signedIn,
      tokenIsFresh,
      uid,
      vaultOwnerToken,
      voiceActive,
      voiceStatus,
    ]
  );

  const tier = useMemo(
    () =>
      deriveTier({
        signedIn,
        hasVaultAccess,
        onboardingActive,
        isHomeRoute,
      }),
    [signedIn, hasVaultAccess, onboardingActive, isHomeRoute]
  );

  const value = useMemo<AgentRuntimeState>(
    () => {
      // Handler mount/unmount is part of executable surface coherence even
      // when no other snapshot input changes.
      void localHandlerRevision;
      const compatibilitySnapshot = buildOneVoiceContextSnapshot({
        appRuntimeState,
        surfaceMetadata,
        state: oneVoiceState,
        lastTransition: lastVoiceTransition,
        voiceSettings: {
          voiceEnabled: voicePreferences.voiceEnabled,
          requireTapConfirmation: voicePreferences.requireTapConfirmation,
          disabledDomains: voicePreferences.disabledDomains,
        },
        onboarding: {
          phase: (path === ROUTES.GETTING_STARTED || path === ROUTES.LOGIN || path === ROUTES.PHONE_MANDATE || path.startsWith(ROUTES.ONE_SETUP))
            ? resolveOnboardingPhase({
                path,
                signedIn,
                setupResolved: PreVaultUserStateService.isSetupResolved(preVaultState),
              })
            : preVaultState?.onboardingPhase || resolveOnboardingPhase({
            path,
            signedIn,
            setupResolved: PreVaultUserStateService.isSetupResolved(preVaultState),
          }),
          activeCapability:
            resolveOnboardingCapabilityForRoute(path) ??
            preVaultState?.onboardingActiveCapability ??
            null,
          rootResolved: PreVaultUserStateService.isSetupResolved(preVaultState),
          returnRoute: ROUTES.ONE_SETUP,
          phoneVerified: preVaultState?.phoneVerified ?? null,
          callbackState: preVaultState?.onboardingCallbackState || "none",
          setupCapabilityIds: preVaultState?.setupCapabilityIds || [],
        },
        requireMountedLocalHandlers: true,
      });
      const morphyAxSnapshot = buildMorphyAxSnapshot(compatibilitySnapshot, {
        signedIn,
      });
      const morphyAxEnabled = getVoiceV2Flags().morphyAxEnabled;
      const oneVoiceContextSnapshot = morphyAxEnabled
        ? toOneVoiceContextSnapshot(morphyAxSnapshot, compatibilitySnapshot)
        : compatibilitySnapshot;
      const capabilityState = deriveVoiceCapabilityState({
        appRuntimeState,
        snapshot: oneVoiceContextSnapshot,
      });
      return {
        appRuntimeState,
        tier,
        onboardingActive,
        isHomeRoute,
        hasVaultAccess,
        activePersona,
        screen: routeInfo.screen,
        oneVoiceContextSnapshot,
        capabilityState,
        morphyAxSnapshot,
        morphyAxPresentation: resolveMorphyAxPresentation(oneVoiceState),
        morphyAxEnabled,
      };
    },
    [
      appRuntimeState,
      tier,
      onboardingActive,
      isHomeRoute,
      hasVaultAccess,
      activePersona,
      lastVoiceTransition,
      oneVoiceState,
      routeInfo.screen,
      path,
      preVaultState,
      signedIn,
      surfaceMetadata,
      localHandlerRevision,
      voicePreferences,
    ]
  );

  return (
    <AgentRuntimeStateContext.Provider value={value}>
      {children}
    </AgentRuntimeStateContext.Provider>
  );
}

/**
 * Read the shared agent runtime state. Returns null when used outside the
 * provider so callers in non-app trees degrade gracefully.
 */
export function useAgentRuntimeStateOptional(): AgentRuntimeState | null {
  return useContext(AgentRuntimeStateContext);
}

/**
 * Read the shared agent runtime state. Throws when used outside the provider.
 */
export function useAgentRuntimeState(): AgentRuntimeState {
  const value = useContext(AgentRuntimeStateContext);
  if (!value) {
    throw new Error(
      "useAgentRuntimeState must be used within an AgentRuntimeStateProvider"
    );
  }
  return value;
}
