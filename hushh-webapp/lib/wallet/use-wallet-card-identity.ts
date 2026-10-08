"use client";

import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ReferralService } from "@/lib/services/referral-service";
import {
  WALLET_CARD_CHANGED_EVENT,
  WalletCardService,
  type WalletCardPayload,
} from "@/lib/services/wallet-card-service";
import {
  EMPTY_WALLET_CARD_IDENTITY,
  deriveWalletCardDates,
  resolveWalletProfileStatus,
  type WalletCardIdentity,
  type WalletProfileStatus,
} from "@/lib/wallet/wallet-card-identity";

const REFRESH_MS = 15_000;

interface LoadedProfile {
  ownerId: string;
  status: WalletProfileStatus;
  cardName: string | null;
  profileUrl: string | null;
  cardPayload: WalletCardPayload | null;
}

interface LoadedReferral {
  ownerId: string;
  url: string;
}

interface LoadedAccount {
  ownerId: string;
  /** The account's saved name when Firebase carries none. */
  name: string | null;
  /** Firebase's creation time from the backend when the client carries none. */
  createdAt: string | null;
}

/**
 * The account's display name as the backend last confirmed it. Firebase Auth is
 * the source of the name and the Profile name edit writes it there, then caches
 * the confirmed identity. A native Firebase user object is a snapshot whose
 * `reload()` does nothing, so after an edit it can still carry the old name;
 * this cached mirror cannot. Memory read only: no request, never another owner.
 */
function cachedAccountName(ownerId: string | null): string | null {
  if (!ownerId) return null;
  const identity = AccountIdentityService.peekCachedIdentity(ownerId)?.data;
  if (!identity || identity.user_id !== ownerId) return null;
  return identity.display_name?.trim() || null;
}

/** Runs `refresh` whenever the person could have changed something elsewhere. */
function subscribeToRefreshSignals(refresh: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  window.addEventListener(WALLET_CARD_CHANGED_EVENT, refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener(WALLET_CARD_CHANGED_EVENT, refresh);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * The one authenticated source behind every Agent One card in Wallet.
 *
 * - name: the saved Wallet Profile name (`full_name`, then the card's display
 *   name), then the account's Firebase Auth `displayName`. That tier reads the
 *   backend identity's `display_name` (Firebase's value as the server confirmed
 *   it, kept current by Profile name edits) and falls back to the live
 *   `user.displayName`. Nothing else: no email, no sample;
 * - member since / valid through: Firebase `metadata.creationTime` from the
 *   signed-in user (web SDK, or the native plugin's `metadata.creationTime`),
 *   so they never wait on a network call. Only when the client has none, the
 *   backend's `GET /api/account/created-at` (Firebase Admin creation timestamp).
 *   Neither depends on the Wallet Profile, the vault or any QR;
 * - profile QR and `profileStatus`: the owner's Wallet Profile as the server
 *   reports it, plus the share link this device holds for it;
 * - referral QR: the server's Invite friends link for this owner. It loads on
 *   its own, so Wallet Profile setup, a locked vault or a failed profile request
 *   can never hold it back.
 *
 * Everything is keyed by the signed-in uid. A value fetched for another account
 * is discarded at read time, so logging out or switching accounts can never show
 * the previous owner's details while the next ones load.
 */
export function useWalletCardIdentity(): WalletCardIdentity {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const ownerId = user?.uid ?? null;
  const [profile, setProfile] = useState<LoadedProfile | null>(null);
  const [referral, setReferral] = useState<LoadedReferral | null>(null);
  const [account, setAccount] = useState<LoadedAccount | null>(null);

  // The token getter's identity changes with the vault context; reading it
  // through a ref keeps it out of the effect deps and the poll from restarting.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  const userRef = useRef(user);
  useEffect(() => {
    getVaultOwnerTokenRef.current = getVaultOwnerToken;
    userRef.current = user;
  });

  // Wallet Profile: status, saved name and the share link held on this device.
  useEffect(() => {
    if (!ownerId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const vaultOwnerToken = getVaultOwnerTokenRef.current?.() ?? null;
      // Without the vault there is nothing to ask. That is "not known yet",
      // never "no profile".
      if (!vaultOwnerToken) return;
      let state;
      try {
        state = await WalletCardService.getCard({ userId: ownerId, vaultOwnerToken });
      } catch {
        // A failed read keeps what this owner already had; it never invents "none".
        return;
      }
      if (cancelled || userRef.current?.uid !== ownerId) return;
      const status = resolveWalletProfileStatus(state);
      setProfile({
        ownerId,
        status,
        cardName:
          status === "ready" || status === "link-missing"
            ? state.card?.cardPayload.full_name?.trim() || state.card?.displayName?.trim() || null
            : null,
        profileUrl: status === "ready" ? state.shareUrl?.trim() || null : null,
        cardPayload:
          status === "ready" || status === "link-missing" ? (state.card?.cardPayload ?? null) : null,
      });
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const unsubscribe = subscribeToRefreshSignals(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ownerId, vaultKey]);

  // Invite friends link. The server mints it on first ask and returns the same
  // one afterwards, so it is read until it succeeds once and then left alone.
  useEffect(() => {
    if (!ownerId) {
      setReferral(null);
      return;
    }
    let cancelled = false;
    let known = false;
    let inflight = false;
    const load = async () => {
      const activeUser = userRef.current;
      if (known || inflight || !activeUser || activeUser.uid !== ownerId) return;
      inflight = true;
      try {
        const idToken = await activeUser.getIdToken();
        const summary = await ReferralService.getSummary({ idToken });
        const url = summary?.link?.trim();
        if (!url || cancelled || userRef.current?.uid !== ownerId) return;
        known = true;
        setReferral({ ownerId, url });
      } catch {
        // Retried on the next signal; the gold card stays empty meanwhile.
      } finally {
        inflight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const unsubscribe = subscribeToRefreshSignals(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ownerId]);

  // Account facts the Firebase user may not carry. Asked only for what is
  // missing, independently of the Wallet Profile and the vault, and never again
  // once answered.
  const ownAccount = account?.ownerId === ownerId ? account : null;
  const accountName = cachedAccountName(ownerId);
  const needsAccountName =
    Boolean(ownerId) && !user?.displayName?.trim() && !accountName && !ownAccount?.name;
  const needsCreatedAt =
    Boolean(ownerId) && !deriveWalletCardDates(user?.metadata?.creationTime) && !ownAccount?.createdAt;
  useEffect(() => {
    if (!ownerId || (!needsAccountName && !needsCreatedAt)) return;
    let cancelled = false;
    let inflight = false;
    const load = async () => {
      const activeUser = userRef.current;
      if (inflight || !activeUser || activeUser.uid !== ownerId) return;
      inflight = true;
      try {
        const [identity, createdAt] = await Promise.all([
          needsAccountName
            ? AccountIdentityService.getIdentitySwr(activeUser)
                .then((result) => result.identity)
                .catch(() => null)
            : Promise.resolve(null),
          needsCreatedAt
            ? AccountIdentityService.getAccountCreatedAt(activeUser).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled || userRef.current?.uid !== ownerId) return;
        const name = identity?.user_id === ownerId ? identity.display_name?.trim() || null : null;
        setAccount((previous) => {
          const own = previous?.ownerId === ownerId ? previous : null;
          return { ownerId, name: name ?? own?.name ?? null, createdAt: createdAt ?? own?.createdAt ?? null };
        });
      } finally {
        inflight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const unsubscribe = subscribeToRefreshSignals(() => void load());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ownerId, needsAccountName, needsCreatedAt]);

  if (!user || !ownerId) return EMPTY_WALLET_CARD_IDENTITY;

  const ownProfile = profile?.ownerId === ownerId ? profile : null;
  const ownReferral = referral?.ownerId === ownerId ? referral : null;
  const dates =
    deriveWalletCardDates(user.metadata?.creationTime) ?? deriveWalletCardDates(ownAccount?.createdAt);
  return {
    ownerId,
    name:
      ownProfile?.cardName ||
      accountName ||
      user.displayName?.trim() ||
      ownAccount?.name ||
      null,
    memberSince: dates?.memberSince ?? null,
    validThru: dates?.validThru ?? null,
    profileUrl: ownProfile?.profileUrl ?? null,
    profileStatus: ownProfile?.status ?? "unknown",
    cardPayload: ownProfile?.cardPayload ?? null,
    referralUrl: ownReferral?.url ?? null,
  };
}
