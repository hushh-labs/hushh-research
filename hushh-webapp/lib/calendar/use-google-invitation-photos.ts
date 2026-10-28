"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAuthSessionGeneration, isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { exactInvitationEmails, GooglePhotoProviderError, lookupGoogleInvitationPhoto, warmGoogleContactsPhotoSearch, type GoogleInvitationPhoto } from "@/lib/services/google-invitation-photos";
import { GOOGLE_GUEST_PHOTO_SCOPE, GoogleGuestPhotoTokenError, requestGoogleInvitationPhotoGrant, type GooglePhotoGrant, type GooglePhotoPermission } from "@/lib/services/google-invitation-photo-token";

type Cached = { photo: GoogleInvitationPhoto | null; checkedAt: number };
const FRESH_MS = 60_000;
const MAX_AGE_MS = 5 * 60_000;
type RetainedGrant = { accountKey: string; grant: GooglePhotoGrant; expiryTimer: ReturnType<typeof setTimeout>; unsubscribe: () => void };
let retainedGrant: RetainedGrant | null = null;

/** A single browser-memory grant survives an Invitations tab remount, never an account change. */
export function forgetGoogleInvitationPhotoGrant(accountKey?: string): void {
  if (!retainedGrant || (accountKey && retainedGrant.accountKey !== accountKey)) return;
  clearTimeout(retainedGrant.expiryTimer);
  retainedGrant.unsubscribe();
  retainedGrant = null;
}

function restoreGoogleInvitationPhotoGrant(accountKey: string): GooglePhotoGrant | null {
  return retainedGrant?.accountKey === accountKey && retainedGrant.grant.expiresAt > Date.now() ? retainedGrant.grant : null;
}

function rememberGoogleInvitationPhotoGrant(accountKey: string, grant: GooglePhotoGrant): void {
  forgetGoogleInvitationPhotoGrant();
  const remaining = grant.expiresAt - Date.now();
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (remaining <= 0 || !principal) return;
  const unsubscribe = subscribeAuthSessionGeneration(() => {
    if (!isValidatedAuthSessionOwnerCurrent(principal)) forgetGoogleInvitationPhotoGrant(accountKey);
  });
  retainedGrant = { accountKey, grant, expiryTimer: setTimeout(() => forgetGoogleInvitationPhotoGrant(accountKey), remaining), unsubscribe };
}

type Options = {
  enabled: boolean;
  ownerId: string; accountId: string; accountEmail?: string | null;
  grantGeneration?: string; grantedScopes?: string; subjectSha256?: string; hostedDomain?: string | null;
  guestPhotoAccess?: boolean; getIdToken: () => Promise<string>; vaultOwnerToken?: string | null;
  guestEmails: (string | null | undefined)[];
};

export function useGoogleInvitationPhotos({ enabled, ownerId, accountId, accountEmail, grantGeneration = "", grantedScopes = "", subjectSha256 = "", hostedDomain, guestPhotoAccess = false, getIdToken, vaultOwnerToken, guestEmails }: Options) {
  const emailsKey = exactInvitationEmails(guestEmails).join("\n");
  useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  // Calendar receives the Firebase UID. The validated principal also binds it to
  // the application owner and changes generation across sign-out and reauth.
  const principal = snapshotValidatedAuthSessionPrincipal();
  const selectedPrincipal = principal?.firebaseUid === ownerId ? principal : null;
  const selectedGeneration = selectedPrincipal?.generation;
  const accountKey = JSON.stringify([ownerId, selectedPrincipal?.ownerId, selectedPrincipal?.accountGeneration, selectedPrincipal?.generation, accountId, accountEmail?.trim().toLowerCase() || "", grantGeneration, grantedScopes, subjectSha256, hostedDomain || "", guestPhotoAccess, Boolean(vaultOwnerToken)]);
  const canReadPhotos = enabled && guestPhotoAccess && Boolean(selectedPrincipal && accountEmail && vaultOwnerToken)
    && /^[a-f0-9]{64}$/.test(subjectSha256) && /^[a-f0-9]{64}$/.test(grantGeneration)
    && grantedScopes.split(/\s+/u).includes(GOOGLE_GUEST_PHOTO_SCOPE);
  const grantRef = useRef<GooglePhotoGrant | null>(canReadPhotos ? restoreGoogleInvitationPhotoGrant(accountKey) : null);
  const [photos, setPhotos] = useState<ReadonlyMap<string, GoogleInvitationPhoto>>(() => new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState<GooglePhotoPermission | null>(grantRef.current?.permission || null);
  const [grantVersion, setGrantVersion] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const authAbort = useRef<AbortController | null>(null);
  const readAbort = useRef<AbortController | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cache = useRef(new Map<string, Cached>());
  const warmedGrant = useRef<string | null>(null);
  const attemptedAccount = useRef<string | null>(null);
  const idTokenGetter = useRef(getIdToken);
  idTokenGetter.current = getIdToken;
  const vaultToken = useRef(vaultOwnerToken);
  vaultToken.current = vaultOwnerToken;
  const [displayKey, setDisplayKey] = useState(accountKey);
  const currentAccount = useRef(accountKey);
  currentAccount.current = accountKey;

  useEffect(() => {
    if (retainedGrant && (retainedGrant.accountKey !== accountKey || retainedGrant.grant.expiresAt <= Date.now())) {
      forgetGoogleInvitationPhotoGrant();
    }
  }, [accountKey]);
  useEffect(() => {
    if (!permission) return;
    const timer = window.setInterval(() => setRefreshTick(value => value + 1), FRESH_MS);
    const onReturn = () => { if (document.visibilityState === "visible") setRefreshTick(value => value + 1); };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onReturn); window.removeEventListener("focus", onReturn); };
  }, [permission]);
  useEffect(() => {
    // Account selection, disconnect, or grant change immediately drops all photos.
    if (displayKey !== accountKey) {
      forgetGoogleInvitationPhotoGrant(displayKey);
      setDisplayKey(accountKey);
      setPhotos(new Map());
      setPermission(null);
      setMessage(null);
      setLoading(false);
      setGrantVersion(value => value + 1);
    }
    const photoCache = cache.current;
    return () => {
      authAbort.current?.abort();
      readAbort.current?.abort();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      grantRef.current = null;
      photoCache.clear();
      warmedGrant.current = null;
      attemptedAccount.current = null;
    };
  }, [accountKey, displayKey]);

  const clear = useCallback(() => {
    authAbort.current?.abort();
    readAbort.current?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    grantRef.current = null;
    forgetGoogleInvitationPhotoGrant(accountKey);
    cache.current.clear();
    warmedGrant.current = null;
    setPhotos(new Map());
    setPermission(null);
    setMessage(null);
    setLoading(false);
    setGrantVersion(value => value + 1);
  }, [accountKey]);

  useEffect(() => {
    const grant = grantRef.current;
    if (!grant) return;
    const expire = () => {
      if (grantRef.current !== grant) return;
      clear();
      attemptedAccount.current = null;
    };
    const remaining = grant.expiresAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [grantVersion, clear]);

  const authorize = useCallback(async () => {
    if (!canReadPhotos || !selectedPrincipal || !accountEmail || displayKey !== accountKey) return;
    if (grantRef.current?.expiresAt && grantRef.current.expiresAt > Date.now()) return;
    authAbort.current?.abort();
    readAbort.current?.abort();
    const controller = new AbortController();
    authAbort.current = controller;
    const expectedAccount = accountKey;
    const expectedPrincipal = selectedPrincipal;
    setLoading(true);
    setMessage(null);
    try {
      const idToken = await idTokenGetter.current();
      if (controller.signal.aborted || currentAccount.current !== expectedAccount || !isValidatedAuthSessionOwnerCurrent(expectedPrincipal)) return;
      const ownerToken = vaultToken.current;
      if (!ownerToken) return;
      const grant = await requestGoogleInvitationPhotoGrant({
        idToken, vaultOwnerToken: ownerToken, ownerId, accountId, accountEmail, subjectSha256, grantGeneration,
        signal: controller.signal,
      });
      if (controller.signal.aborted || currentAccount.current !== expectedAccount || !isValidatedAuthSessionOwnerCurrent(expectedPrincipal)) return;
      grantRef.current = grant;
      rememberGoogleInvitationPhotoGrant(accountKey, grant);
      warmedGrant.current = null;
      cache.current.clear();
      setPhotos(new Map());
      setPermission("contacts");
      setGrantVersion(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted && currentAccount.current === expectedAccount && isValidatedAuthSessionOwnerCurrent(expectedPrincipal)) {
        setMessage(error instanceof Error ? error.message : "Google photo access was unavailable.");
        if (!(error instanceof GoogleGuestPhotoTokenError) || error.retryable) {
          retryTimer.current = setTimeout(() => {
            if (currentAccount.current !== expectedAccount || !isValidatedAuthSessionOwnerCurrent(expectedPrincipal)) return;
            attemptedAccount.current = null;
            setRefreshTick(value => value + 1);
          }, 120_000);
        }
      }
    } finally {
      if (!controller.signal.aborted && currentAccount.current === expectedAccount && isValidatedAuthSessionOwnerCurrent(expectedPrincipal)) setLoading(false);
    }
  }, [canReadPhotos, selectedPrincipal, accountEmail, subjectSha256, grantGeneration, ownerId, accountId, accountKey, displayKey]);

  useEffect(() => {
    if (!canReadPhotos || !emailsKey || displayKey !== accountKey
      || attemptedAccount.current === accountKey || grantRef.current) return;
    attemptedAccount.current = accountKey;
    void authorize();
  }, [accountKey, displayKey, canReadPhotos, emailsKey, authorize, grantVersion, refreshTick]);

  useEffect(() => {
    const grant = grantRef.current;
    if (!grant) return;
    const readPrincipal = snapshotValidatedAuthSessionPrincipal();
    if (!readPrincipal || readPrincipal.firebaseUid !== ownerId || readPrincipal.generation !== selectedGeneration || displayKey !== accountKey) return;
    if (grant.expiresAt <= Date.now()) { clear(); attemptedAccount.current = null; return; }
    if (!emailsKey) { setPhotos(new Map()); return; }
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    const expectedPrincipal = readPrincipal;
    const stillCurrent = () => !controller.signal.aborted && currentAccount.current === accountKey && grantRef.current === grant && isValidatedAuthSessionOwnerCurrent(expectedPrincipal);
    const emails = emailsKey.split("\n");
    const now = Date.now();
    const cachedPhotos = new Map<string, GoogleInvitationPhoto>();
    for (const email of emails) {
      const cached = cache.current.get(`${accountKey}:${grant.subject}:${grant.permission}:${email}`);
      if (cached && now - cached.checkedAt < MAX_AGE_MS && cached.photo) cachedPhotos.set(email, cached.photo);
    }
    setPhotos(cachedPhotos);
    void (async () => {
      try {
        const warmKey = `${grant.subject}:${grant.permission}`;
        if (grant.permission === "contacts" && warmedGrant.current !== warmKey) {
          await warmGoogleContactsPhotoSearch(grant, controller.signal);
          if (!stillCurrent()) return;
          warmedGrant.current = warmKey;
        }
        const pending = emails.filter(email => {
          const cached = cache.current.get(`${accountKey}:${grant.subject}:${grant.permission}:${email}`);
          return !cached || now - cached.checkedAt >= FRESH_MS;
        });
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (cursor < pending.length && stillCurrent()) {
            const email = pending[cursor++];
            if (!email) return;
            try {
              const photo = await lookupGoogleInvitationPhoto(grant, email, controller.signal);
              if (!stillCurrent()) return;
              cache.current.set(`${accountKey}:${grant.subject}:${grant.permission}:${email}`, { photo, checkedAt: Date.now() });
              setPhotos(current => {
                const next = new Map(current);
                if (photo) next.set(email, photo); else next.delete(email);
                return next;
              });
            } catch (error) {
              if (!stillCurrent()) return;
              if (error instanceof GooglePhotoProviderError) {
                clear();
                setMessage(error.message);
                return;
              }
              // A transient or broken photo never blocks the invitation.
            }
          }
        }));
      } catch (error) {
        if (stillCurrent() && error instanceof GooglePhotoProviderError) {
          clear();
          setMessage(error.message);
        }
      }
    })();
    return () => controller.abort();
  }, [accountKey, displayKey, emailsKey, grantVersion, refreshTick, clear, ownerId, selectedGeneration]);

  const current = Boolean(selectedPrincipal && isValidatedAuthSessionOwnerCurrent(selectedPrincipal) && displayKey === accountKey);
  return { photos: current && canReadPhotos && (grantRef.current?.expiresAt || 0) > Date.now() ? photos : new Map<string, GoogleInvitationPhoto>(), message, loading, permission: current ? permission : null, clear,
    available: current && canReadPhotos };
}
