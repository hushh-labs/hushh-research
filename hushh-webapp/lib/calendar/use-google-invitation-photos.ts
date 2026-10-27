"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { exactInvitationEmails, GooglePhotoProviderError, lookupGoogleInvitationPhoto, warmGoogleContactsPhotoSearch, type GoogleInvitationPhoto } from "@/lib/services/google-invitation-photos";
import { googleInvitationPhotosAvailable, isGoogleContactsConsentCancelled, preloadGoogleInvitationPhotoAuth, requestGoogleInvitationPhotoGrant, type GooglePhotoGrant, type GooglePhotoPermission } from "@/lib/services/google-invitation-photo-token";

type Cached = { photo: GoogleInvitationPhoto | null; checkedAt: number };
const FRESH_MS = 60_000;
const MAX_AGE_MS = 5 * 60_000;
type RetainedGrant = { accountKey: string; grant: GooglePhotoGrant; expiryTimer: ReturnType<typeof setTimeout> };
let retainedGrant: RetainedGrant | null = null;

/** A single browser-memory grant survives an Invitations tab remount, never an account change. */
export function forgetGoogleInvitationPhotoGrant(accountKey?: string): void {
  if (!retainedGrant || (accountKey && retainedGrant.accountKey !== accountKey)) return;
  clearTimeout(retainedGrant.expiryTimer);
  retainedGrant = null;
}

function restoreGoogleInvitationPhotoGrant(accountKey: string): GooglePhotoGrant | null {
  return retainedGrant?.accountKey === accountKey && retainedGrant.grant.expiresAt > Date.now() ? retainedGrant.grant : null;
}

function rememberGoogleInvitationPhotoGrant(accountKey: string, grant: GooglePhotoGrant): void {
  forgetGoogleInvitationPhotoGrant();
  const remaining = grant.expiresAt - Date.now();
  if (remaining <= 0) return;
  retainedGrant = { accountKey, grant, expiryTimer: setTimeout(() => forgetGoogleInvitationPhotoGrant(accountKey), remaining) };
}

type Options = {
  enabled: boolean;
  ownerId: string; accountId: string; accountEmail?: string | null;
  grantGeneration?: string; grantedScopes?: string; subjectSha256?: string; hostedDomain?: string | null;
  guestEmails: (string | null | undefined)[];
};

export function useGoogleInvitationPhotos({ enabled, ownerId, accountId, accountEmail, grantGeneration = "", grantedScopes = "", subjectSha256 = "", hostedDomain, guestEmails }: Options) {
  const emailsKey = exactInvitationEmails(guestEmails).join("\n");
  const accountKey = JSON.stringify([ownerId, accountId, accountEmail?.trim().toLowerCase() || "", grantGeneration, grantedScopes, subjectSha256, hostedDomain || ""]);
  const grantRef = useRef<GooglePhotoGrant | null>(enabled ? restoreGoogleInvitationPhotoGrant(accountKey) : null);
  const [photos, setPhotos] = useState<ReadonlyMap<string, GoogleInvitationPhoto>>(() => new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState<GooglePhotoPermission | null>(grantRef.current?.permission || null);
  const [grantVersion, setGrantVersion] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const authAbort = useRef<AbortController | null>(null);
  const readAbort = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, Cached>());
  const warmedGrant = useRef<string | null>(null);
  const [displayKey, setDisplayKey] = useState(accountKey);
  const currentAccount = useRef(accountKey);
  currentAccount.current = accountKey;

  useEffect(() => { if (enabled) void preloadGoogleInvitationPhotoAuth().catch(() => undefined); }, [enabled]);
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
      grantRef.current = null;
      photoCache.clear();
      warmedGrant.current = null;
    };
  }, [accountKey, displayKey]);

  const clear = useCallback(() => {
    authAbort.current?.abort();
    readAbort.current?.abort();
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
      setMessage("Google photo access expired. Choose the account again.");
    };
    const remaining = grant.expiresAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [grantVersion, clear]);

  const authorize = useCallback(async (mode: GooglePhotoPermission) => {
    if (!enabled || !accountEmail || !subjectSha256 || !googleInvitationPhotosAvailable()) return;
    if (grantRef.current?.permission === mode && grantRef.current.expiresAt > Date.now()) return;
    authAbort.current?.abort();
    readAbort.current?.abort();
    const controller = new AbortController();
    authAbort.current = controller;
    const expectedAccount = accountKey;
    const epoch = snapshotVaultSessionEpoch();
    setLoading(true);
    setMessage(null);
    try {
      const grant = await requestGoogleInvitationPhotoGrant(accountEmail, subjectSha256, hostedDomain, mode, controller.signal);
      if (controller.signal.aborted || currentAccount.current !== expectedAccount || !isVaultSessionEpochCurrent(epoch)) return;
      grantRef.current = grant;
      rememberGoogleInvitationPhotoGrant(accountKey, grant);
      warmedGrant.current = null;
      cache.current.clear();
      setPhotos(new Map());
      setPermission(mode);
      setGrantVersion(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted && currentAccount.current === expectedAccount && !isGoogleContactsConsentCancelled(error)) {
        setMessage(error instanceof Error ? error.message : "Google photo access was unavailable.");
      }
    } finally {
      if (!controller.signal.aborted && currentAccount.current === expectedAccount) setLoading(false);
    }
  }, [enabled, accountEmail, subjectSha256, hostedDomain, accountKey]);

  useEffect(() => {
    const grant = grantRef.current;
    if (!grant) return;
    if (grant.expiresAt <= Date.now()) { clear(); setMessage("Google photo access expired. Choose the account again."); return; }
    if (!emailsKey) { setPhotos(new Map()); return; }
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    const epoch = snapshotVaultSessionEpoch();
    const stillCurrent = () => !controller.signal.aborted && currentAccount.current === accountKey && grantRef.current === grant && isVaultSessionEpochCurrent(epoch);
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
  }, [accountKey, emailsKey, grantVersion, refreshTick, clear]);

  return { photos: displayKey === accountKey && (grantRef.current?.expiresAt || 0) > Date.now() ? photos : new Map<string, GoogleInvitationPhoto>(), message, loading, permission, authorize, clear,
    available: enabled && Boolean(accountEmail) && /^[a-f0-9]{64}$/.test(subjectSha256) && googleInvitationPhotosAvailable() };
}
