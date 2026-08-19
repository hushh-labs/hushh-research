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
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useHostname } from "@/lib/hooks/use-hostname";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import {
  hasVerifiedPhoneNumber,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { hasExplicitIncompleteSetup } from "@/lib/onboarding/setup-admission";
import {
  resolveUserEntryState,
  type UserEntryState,
} from "@/lib/onboarding/user-entry-state";

export type OnboardingEntryValue = {
  /** The one decision. Never a guess: unknown inputs keep it on `booting`. */
  entry: UserEntryState;
  /**
   * The capability the durable record says is mid-setup, if any. Not part of
   * the decision — it only widens which routes the setup step may sit on while
   * a capability handoff (an OAuth return, a permission prompt) is in flight.
   */
  activeCapability: string | null;
  /**
   * Whether this account owns a lock, from the one record both gates now read.
   * They used to derive it from different stores with opposite precedence, so
   * one could believe a lock existed while the other believed it did not.
   */
  hasVault: boolean | null;
  /** True when the durable record could not be read at all. */
  failed: boolean;
  /**
   * True from the moment the setup hub commits its completion until it has
   * navigated away.
   *
   * Completion is written durably BEFORE the hub navigates, so for a frame or
   * two the decision already says "finished" while the person is still standing
   * on the hub. Ejecting them in that frame unmounts the hub before its own
   * navigation runs — and the hub is the only thing that knows the destination
   * is sometimes the portfolio-import step rather than home. So the guard steps
   * aside and lets the hub finish the move it started.
   */
  funnelExitInFlight: boolean;
  /** Called by the setup hub as it commits completion. */
  beginFunnelExit: () => void;
  /** Re-read the durable record after a failure. */
  retry: () => void;
};

const BOOTSTRAP_RETRY_MS = 300;

const BOOTING: UserEntryState = {
  step: "booting",
  resolved: false,
  signedIn: false,
  destination: "/one",
  surface: "none",
  lockState: "loading",
};

const OnboardingEntryContext = createContext<OnboardingEntryValue>({
  entry: BOOTING,
  activeCapability: null,
  hasVault: null,
  failed: false,
  funnelExitInFlight: false,
  beginFunnelExit: () => undefined,
  retry: () => undefined,
});

/**
 * Gathers every input the entry decision needs, in one place, once.
 *
 * Before this, three guards each fetched their own copy of the same durable
 * record and each redirected on its own schedule. They now read the answer from
 * here instead, which is what makes the states mutually exclusive: there is one
 * decision, so there cannot be two.
 *
 * Everything it reads is already shared and single-flighted, so consolidating
 * removes network round-trips rather than adding them.
 */
export function OnboardingEntryProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading, phoneNumber } = useAuth();
  const { isVaultUnlocked } = useVault();
  const pathname = usePathname() || "/";
  const hostname = useHostname();
  const environmentResolved = hostname !== null;
  const userId = user?.uid ?? null;

  const [record, setRecord] = useState<PreVaultUserState | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  // `null` while a native cold start is still restoring the durable latch.
  const [latch, setLatch] = useState<boolean | null>(null);
  const [identityPhoneVerified, setIdentityPhoneVerified] = useState<
    boolean | null
  >(null);
  const [funnelExitInFlight, setFunnelExitInFlight] = useState(false);
  const identityLookupRef = useRef<string | null>(null);

  const firebasePhoneVerified = hasVerifiedPhoneNumber(phoneNumber);

  // The phone step does not apply on localhost, under the native route-audit
  // bridge, or on the adviser claim route. Ask the same predicate the mandate
  // itself uses, with inputs that isolate the bypasses from the claim.
  const phoneMandateWaived =
    environmentResolved &&
    !shouldRequirePhoneMandate({
      phoneNumber: null,
      phoneVerified: false,
      hasVault: false,
      hostname,
      pathname,
    });

  // Reset every derived input the moment the account changes, so one person's
  // resolved state can never decide another person's first screen.
  useEffect(() => {
    setRecord(null);
    setFailed(false);
    setLatch(null);
    setIdentityPhoneVerified(null);
    identityLookupRef.current = null;
  }, [userId]);

  // The positive completion latch. Synchronous on web; a native cold start has
  // to restore it from the durable store first, because WKWebView drops
  // localStorage between launches under the custom scheme.
  useEffect(() => {
    if (!userId) {
      setLatch(null);
      return;
    }
    if (OneSetupCompletionHintService.isResolved(userId)) {
      setLatch(true);
      return;
    }
    if (!Capacitor.isNativePlatform()) {
      setLatch(false);
      return;
    }
    let cancelled = false;
    void OneSetupCompletionHintService.hydrateFromNative(userId)
      .then((restored) => {
        if (!cancelled) setLatch(restored);
      })
      .catch(() => {
        if (!cancelled) setLatch(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, retryNonce]);

  // The shared durable record. Single-flighted and session-cached by the
  // service, so mounting this provider costs at most one request per session.
  useEffect(() => {
    if (!userId || !environmentResolved) return;
    const cached = PreVaultUserStateService.getCachedBootstrapState(userId);
    if (cached) {
      setRecord(cached);
      setFailed(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        return await PreVaultUserStateService.bootstrapState(userId);
      } catch {
        // Native session restoration and cross-tab web auth can publish the
        // account before the token provider is ready to sign for it. One
        // bounded forced retry covers that window; anything past it is a real
        // failure and gets reported rather than looped on.
        await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_RETRY_MS));
        if (cancelled) return null;
        return PreVaultUserStateService.bootstrapState(userId, { force: true });
      }
    })()
      .then((state) => {
        if (cancelled || !state) return;
        setRecord(state);
        setFailed(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(
          "[OnboardingEntryProvider] Could not read setup state:",
          error,
        );
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, environmentResolved, retryNonce]);

  // Another surface can refresh the same record (finishing setup, settling a
  // connector callback). Follow its cache writes so the decision here moves
  // with it instead of holding a stale answer for the rest of the session.
  useEffect(() => {
    if (!userId) return;
    const key = CACHE_KEYS.PRE_VAULT_BOOTSTRAP(userId);
    return CacheService.getInstance().subscribe((event) => {
      if (event.type !== "set" || event.key !== key) return;
      const next = PreVaultUserStateService.getCachedBootstrapState(userId);
      if (next) {
        setRecord(next);
        setFailed(false);
      }
    });
  }, [userId]);

  // Older backends do not return a phone claim at all. Only then is a separate
  // identity read worth its round-trip.
  useEffect(() => {
    if (!userId || !user || firebasePhoneVerified) return;
    if (!record || record.phoneVerified !== null) return;
    const cached = AccountIdentityService.peekCachedIdentity(userId);
    if (cached) {
      setIdentityPhoneVerified(
        AccountIdentityService.hasVerifiedPhone(cached.data),
      );
      return;
    }
    if (identityLookupRef.current === userId) return;
    identityLookupRef.current = userId;
    let cancelled = false;
    void AccountIdentityService.getIdentitySwr(user)
      .then(({ identity }) => {
        if (!cancelled) {
          setIdentityPhoneVerified(
            AccountIdentityService.hasVerifiedPhone(identity),
          );
        }
      })
      .catch((error) => {
        console.warn(
          "[OnboardingEntryProvider] Could not read the phone claim:",
          error,
        );
        // Fail closed: an unreadable claim keeps the phone step in front of
        // private data rather than waving it through.
        if (!cancelled) setIdentityPhoneVerified(false);
      });
    return () => {
      cancelled = true;
    };
  }, [firebasePhoneVerified, record, user, userId]);

  const hasVault: boolean | null = isVaultUnlocked
    ? true
    : record
      ? record.hasVault
      : // A cached negative is not authority to treat an account as having no
        // lock; only a positive one short-circuits the read.
        userId && VaultService.peekVaultPresence(userId) === true
        ? true
        : null;

  const entry = useMemo<UserEntryState>(() => {
    const phoneVerified: boolean | null = firebasePhoneVerified
      ? true
      : !record
        ? null
        : record.phoneVerified !== null
          ? record.phoneVerified
          : identityPhoneVerified;

    const setupCompleted: boolean | null =
      latch === true
        ? true
        : latch === null
          ? null
          : !record
            ? null
            : record.setupCompleted === true
              ? true
              : hasExplicitIncompleteSetup(record)
                ? false
                : // No explicit incomplete record: an account that predates the
                  // journey mirror is established, not unfinished.
                  true;

    return resolveUserEntryState({
      environmentResolved,
      authResolved: !authLoading,
      userId,
      phoneVerified,
      hasVault,
      vaultUnlocked: isVaultUnlocked,
      setupCompleted,
      phoneMandateWaived,
    });
  }, [
    authLoading,
    environmentResolved,
    firebasePhoneVerified,
    hasVault,
    identityPhoneVerified,
    isVaultUnlocked,
    latch,
    phoneMandateWaived,
    record,
    userId,
  ]);

  const beginFunnelExit = useCallback(() => setFunnelExitInFlight(true), []);

  // The hand-off ends the moment the hub actually leaves. Keyed on the route
  // rather than a duration, so a slow durable write cannot cut it short and a
  // fast one cannot leave it hanging.
  useEffect(() => {
    if (!funnelExitInFlight) return;
    if (pathname.startsWith("/one/setup")) return;
    setFunnelExitInFlight(false);
  }, [funnelExitInFlight, pathname]);

  const retry = useCallback(() => {
    setFailed(false);
    setRetryNonce((value) => value + 1);
  }, []);

  const value = useMemo<OnboardingEntryValue>(
    () => ({
      entry,
      activeCapability: record?.onboardingActiveCapability ?? null,
      hasVault,
      failed,
      funnelExitInFlight,
      beginFunnelExit,
      retry,
    }),
    [beginFunnelExit, entry, hasVault, failed, funnelExitInFlight, record, retry],
  );

  return (
    <OnboardingEntryContext.Provider value={value}>
      {children}
    </OnboardingEntryContext.Provider>
  );
}

export function useOnboardingEntry(): OnboardingEntryValue {
  return useContext(OnboardingEntryContext);
}
