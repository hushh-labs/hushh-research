"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useAuth } from "@/hooks/use-auth";
import { getRouteScope, routePersonaForScope } from "@/lib/navigation/route-scope";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import {
  RiaService,
  type Persona,
  type PersonaState,
  type RiaOnboardingStatus,
} from "@/lib/services/ria-service";
import { ROUTES } from "@/lib/navigation/routes";

export type RiaCapability = "disabled" | "setup" | "switch";

interface PersonaContextValue {
  personaState: PersonaState | null;
  riaOnboardingStatus: RiaOnboardingStatus | null;
  loading: boolean;
  refreshing: boolean;
  personaTransitionTarget: Persona | null;
  activePersona: Persona;
  primaryNavPersona: Persona;
  riaCapability: RiaCapability;
  riaSetupAvailable: boolean;
  riaSwitchAvailable: boolean;
  riaEntryRoute: string;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  switchPersona: (target: Persona) => Promise<PersonaState | null>;
}

const PersonaContext = createContext<PersonaContextValue | null>(null);
const PERSONA_TRANSITION_TIMEOUT_MS = 4_000;

function readCachedPersona(userId: string) {
  const cache = CacheService.getInstance();
  return {
    personaState: cache.get<PersonaState>(CACHE_KEYS.PERSONA_STATE(userId)),
    riaOnboardingStatus: cache.get<RiaOnboardingStatus>(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId)),
  };
}

function shouldLoadRiaOnboardingStatus(
  pathname: string,
  personaState: PersonaState | null
): boolean {
  const normalized = String(pathname || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("/ria")) return true;

  const activePersona = personaState?.active_persona || personaState?.last_active_persona;
  const primaryPersona = personaState?.primary_nav_persona;
  const riaContext = activePersona === "ria" || primaryPersona === "ria";

  if (normalized.startsWith("/profile")) return riaContext;
  if (normalized.startsWith("/consents")) return riaContext;
  return false;
}

export function PersonaProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [personaState, setPersonaState] = useState<PersonaState | null>(null);
  const [riaOnboardingStatus, setRiaOnboardingStatus] = useState<RiaOnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [personaTransitionTarget, setPersonaTransitionTarget] = useState<Persona | null>(null);
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (authLoading) return;
      if (!isAuthenticated || !user) {
        setPersonaState(null);
        setRiaOnboardingStatus(null);
        setLoading(false);
        setRefreshing(false);
        setPersonaTransitionTarget(null);
        return;
      }

      const cache = CacheService.getInstance();
      const userId = user.uid;
      const force = Boolean(options?.force);
      const cached = readCachedPersona(userId);

      if (!force && cached.personaState) {
        setPersonaState(cached.personaState);
        setRiaOnboardingStatus(cached.riaOnboardingStatus);
        setLoading(false);
      } else {
        setLoading(true);
      }

      setRefreshing(true);
      try {
        const idToken = await user.getIdToken();
        const nextPersona = await RiaService.getPersonaState(idToken, {
          userId,
          force,
        });
        setPersonaState(nextPersona);
        cache.set(CACHE_KEYS.PERSONA_STATE(userId), nextPersona, CACHE_TTL.SESSION);

        if (!nextPersona.iam_schema_ready) {
          setRiaOnboardingStatus(null);
          cache.invalidate(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
          return;
        }

        if (!shouldLoadRiaOnboardingStatus(pathnameRef.current, nextPersona)) {
          setRiaOnboardingStatus(cached.riaOnboardingStatus ?? null);
          return;
        }

        const nextOnboarding = await RiaService.getOnboardingStatus(idToken, {
          userId,
          force,
        }).catch(
          () => null as RiaOnboardingStatus | null
        );
        setRiaOnboardingStatus(nextOnboarding);
        if (nextOnboarding) {
          cache.set(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId), nextOnboarding, CACHE_TTL.SESSION);
        } else {
          cache.invalidate(CACHE_KEYS.RIA_ONBOARDING_STATUS(userId));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [authLoading, isAuthenticated, user]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (authLoading || !isAuthenticated || !user) return;
    if (!shouldLoadRiaOnboardingStatus(pathname, personaState)) return;
    if (riaOnboardingStatus || refreshing) return;
    void refresh();
  }, [
    authLoading,
    isAuthenticated,
    pathname,
    personaState,
    refresh,
    refreshing,
    riaOnboardingStatus,
    user,
  ]);

  const switchPersona = useCallback(
    async (target: Persona) => {
      if (!user || !isAuthenticated) return null;
      setPersonaTransitionTarget(target);
      try {
        const idToken = await user.getIdToken();
        const next = await RiaService.switchPersona(idToken, target);
        const cache = CacheService.getInstance();
        CacheSyncService.onPersonaStateChanged(user.uid, { preservePersonaState: true });
        cache.set(CACHE_KEYS.PERSONA_STATE(user.uid), next, CACHE_TTL.SESSION);
        setPersonaState(next);
        void refresh({ force: true });
        return next;
      } catch (error) {
        setPersonaTransitionTarget(null);
        throw error;
      }
    },
    [isAuthenticated, refresh, user]
  );

  const riaCapability: RiaCapability = useMemo(() => {
    if (!personaState?.iam_schema_ready) return "disabled";
    if (personaState.ria_switch_available ?? personaState.personas.includes("ria")) {
      return "switch";
    }
    return "setup";
  }, [personaState]);

  const activePersona: Persona = useMemo(() => {
    return personaState?.active_persona || personaState?.last_active_persona || "investor";
  }, [personaState]);

  const routePersona = useMemo(() => {
    return routePersonaForScope(getRouteScope(pathname));
  }, [pathname]);

  useEffect(() => {
    if (!personaTransitionTarget) {
      return;
    }

    if (
      activePersona === personaTransitionTarget &&
      (!routePersona || routePersona === personaTransitionTarget)
    ) {
      setPersonaTransitionTarget(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPersonaTransitionTarget((current) =>
        current === personaTransitionTarget ? null : current
      );
    }, PERSONA_TRANSITION_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activePersona, personaTransitionTarget, routePersona]);

  const primaryNavPersona: Persona = useMemo(() => {
    return personaState?.primary_nav_persona || activePersona;
  }, [activePersona, personaState]);

  const riaSwitchAvailable = useMemo(() => {
    if (!personaState?.iam_schema_ready) return false;
    return personaState.ria_switch_available ?? personaState.personas.includes("ria");
  }, [personaState]);

  const riaSetupAvailable = useMemo(() => {
    if (!personaState?.iam_schema_ready) return false;
    return personaState.ria_setup_available ?? !riaSwitchAvailable;
  }, [personaState, riaSwitchAvailable]);

  const riaEntryRoute = useMemo(() => {
    if (riaCapability === "switch") {
      return ROUTES.RIA_HOME;
    }
    return ROUTES.RIA_ONBOARDING;
  }, [riaCapability]);

  const value = useMemo<PersonaContextValue>(
    () => ({
      personaState,
      riaOnboardingStatus,
      loading,
      refreshing,
      personaTransitionTarget,
      activePersona,
      primaryNavPersona,
      riaCapability,
      riaSetupAvailable,
      riaSwitchAvailable,

      riaEntryRoute,
      refresh,
      switchPersona,
    }),
    [
      activePersona,

      loading,
      personaTransitionTarget,
      personaState,
      primaryNavPersona,
      refresh,
      refreshing,
      riaCapability,
      riaEntryRoute,
      riaOnboardingStatus,
      riaSetupAvailable,
      riaSwitchAvailable,
      switchPersona,
    ]
  );

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersonaState() {
  const context = useContext(PersonaContext);
  if (!context) {
    throw new Error("usePersonaState must be used within PersonaProvider");
  }
  return context;
}
