"use client";

import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ReferralService } from "@/lib/services/referral-service";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import {
  EMPTY_WALLET_CARD_IDENTITY,
  deriveWalletCardDates,
  type WalletCardIdentity,
} from "@/lib/wallet/wallet-card-identity";

const REFRESH_MS = 15_000;

interface LoadedIdentity {
  ownerId: string;
  cardName: string | null;
  profileUrl: string | null;
  referralUrl: string | null;
}

/**
 * The one authenticated source behind every Agent One card in Wallet.
 *
 * - name: the saved Wallet Profile name, then the account display name;
 * - member since / valid through: Firebase `metadata.creationTime`, read live
 *   from the signed-in user, so they never wait on a network call;
 * - profile QR: the Profile -> Apple Wallet share link already on this device;
 * - referral QR: the server's Invite friends link for this owner.
 *
 * Everything is keyed by the signed-in uid. A value fetched for another account
 * is discarded at read time, so logging out or switching accounts can never show
 * the previous owner's details while the next ones load.
 */
export function useWalletCardIdentity(): WalletCardIdentity {
  const { user } = useAuth();
  const { vaultKey, getVaultOwnerToken } = useVault();
  const ownerId = user?.uid ?? null;
  const [loaded, setLoaded] = useState<LoadedIdentity | null>(null);

  // The token getter's identity changes with the vault context; reading it
  // through a ref keeps it out of the effect deps and the poll from restarting.
  const getVaultOwnerTokenRef = useRef(getVaultOwnerToken);
  const userRef = useRef(user);
  useEffect(() => {
    getVaultOwnerTokenRef.current = getVaultOwnerToken;
    userRef.current = user;
  });
  // The invite link never changes for an owner, so it is fetched until it
  // succeeds once and not re-requested on every refresh of the profile link.
  const referralRef = useRef<{ ownerId: string; url: string } | null>(null);

  useEffect(() => {
    referralRef.current = null;
    if (!ownerId) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    const isCurrent = () => !cancelled && userRef.current?.uid === ownerId;

    const load = async () => {
      const activeUser = userRef.current;
      if (!activeUser || activeUser.uid !== ownerId) return;
      const vaultOwnerToken = getVaultOwnerTokenRef.current?.() ?? null;
      const knownReferral = referralRef.current?.ownerId === ownerId ? referralRef.current.url : null;

      const [profile, referral] = await Promise.all([
        vaultOwnerToken
          ? WalletCardService.getCard({ userId: ownerId, vaultOwnerToken }).catch(() => null)
          : Promise.resolve(null),
        knownReferral
          ? Promise.resolve(null)
          : Promise.resolve()
              .then(() => activeUser.getIdToken())
              .then((idToken) => ReferralService.getSummary({ idToken }))
              .catch(() => null),
      ]);
      if (!isCurrent()) return;

      const cardName =
        profile?.card?.cardPayload.full_name?.trim() || profile?.card?.displayName?.trim() || null;
      const referralUrl = knownReferral ?? (referral?.link?.trim() || null);
      if (referralUrl) referralRef.current = { ownerId, url: referralUrl };
      const profileUrl = profile?.shareUrl?.trim() || null;
      // A failed refresh keeps what this owner already had instead of blanking
      // a card that was fine a moment ago.
      setLoaded((previous) => {
        const own = previous?.ownerId === ownerId ? previous : null;
        return {
          ownerId,
          cardName: cardName ?? (profile ? null : (own?.cardName ?? null)),
          profileUrl: profileUrl ?? (profile ? null : (own?.profileUrl ?? null)),
          referralUrl,
        };
      });
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ownerId, vaultKey]);

  if (!user || !ownerId) return EMPTY_WALLET_CARD_IDENTITY;

  const current = loaded?.ownerId === ownerId ? loaded : null;
  const dates = deriveWalletCardDates(user.metadata?.creationTime);
  return {
    ownerId,
    name: current?.cardName || user.displayName?.trim() || null,
    memberSince: dates?.memberSince ?? null,
    validThru: dates?.validThru ?? null,
    profileUrl: current?.profileUrl ?? null,
    referralUrl: current?.referralUrl ?? null,
  };
}
