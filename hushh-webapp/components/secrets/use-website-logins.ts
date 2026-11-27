"use client";

import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { WebsiteCredentialError, websiteLoginInput, type WebsiteLoginInput, type WebsiteLoginSummary } from "@/lib/pkm/website-credential";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

type View = {
  items: WebsiteLoginSummary[];
  loading: boolean;
  failed: boolean;
  busy: boolean;
  uncertain: boolean;
  message: string | null;
};
const EMPTY: View = { items: [], loading: false, failed: false, busy: false, uncertain: false, message: null };

/** One unlocked presentation owns every read and mutation. Credentials and
 * drafts never survive lock, identity replacement or a private-screen exit. */
export function useWebsiteLogins() {
  const { userId } = useAuth();
  const { vaultKey, getVaultKey, getVaultOwnerToken } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [visibility, setVisibility] = useState(0);
  const allowed = !!userId && !!vaultKey && !!getVaultOwnerToken() && !privacy?.shielded && privacy?.appIsActive !== false && !privacy?.presentationsRetiring &&
    (!Capacitor.isNativePlatform() || !!privacy) && (typeof document !== "undefined" && document.visibilityState !== "hidden");
  const owner = useMemo(() => ({ live: false, pending: false, reads: 0, userId, vaultKey, epoch, allowed, visibility, generation: privacy?.generation,
    auth: snapshotValidatedAuthSessionOwner() }), [userId, vaultKey, epoch, privacy?.generation, visibility, allowed]);
  const latest = useRef(owner);
  useLayoutEffect(() => {
    latest.current = owner;
    owner.live = allowed;
    return () => { owner.live = false; owner.reads += 1; };
  }, [owner, allowed]);
  useEffect(() => {
    const retire = () => {
      if (document.visibilityState !== "hidden") return;
      owner.live = false; owner.reads += 1; setVisibility(value => value + 1);
    };
    const resume = () => { if (document.visibilityState === "visible") setVisibility(value => value + 1); };
    document.addEventListener("visibilitychange", retire);
    document.addEventListener("visibilitychange", resume);
    return () => { document.removeEventListener("visibilitychange", retire); document.removeEventListener("visibilitychange", resume); };
  }, [owner]);
  const current = useCallback(() => {
    const observation = nativePrivacyObservation().state;
    return owner.live && latest.current === owner && !!userId && owner.auth?.userId === userId &&
      isValidatedAuthSessionOwnerCurrent(owner.auth) && getVaultKey() === owner.vaultKey && snapshotVaultSessionEpoch() === epoch &&
      !!getVaultOwnerToken() && document.visibilityState !== "hidden" && observation?.generation === owner.generation &&
      !observation?.shielded && observation?.appIsActive !== false && !observation?.presentationsRetiring && (!Capacitor.isNativePlatform() || !!observation);
  }, [owner, userId, epoch, getVaultKey, getVaultOwnerToken]);
  const [view, setView] = useOwnerPresentationState(owner, EMPTY);
  const beforeEffect = useCallback(async () => { if (!current()) throw new Error("CREDENTIAL_OWNER_RETIRED"); }, [current]);
  const context = useCallback(() => {
    const vaultOwnerToken = getVaultOwnerToken();
    if (!current() || !userId || !vaultKey || !vaultOwnerToken) throw new Error("CREDENTIAL_OWNER_RETIRED");
    return { userId, vaultKey, vaultOwnerToken, beforeEffect };
  }, [current, userId, vaultKey, getVaultOwnerToken, beforeEffect]);
  const refresh = useCallback(async () => {
    if (!current() || owner.pending) return;
    const read = ++owner.reads;
    setView(previous => ({ ...previous, loading: true, failed: false }));
    try {
      const items = await SecretsVaultService.listWebsiteLogins(context());
      if (current() && owner.reads === read) setView(previous => ({ ...previous, items, loading: false, failed: false, uncertain: false }));
    } catch {
      if (current() && owner.reads === read) setView(previous => ({ ...previous, loading: false, failed: true }));
    }
  }, [current, owner, context, setView]);
  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (!current() || owner.pending || view.uncertain) return false;
    owner.pending = true; owner.reads += 1;
    setView(previous => ({ ...previous, busy: true, message: null }));
    let committed = false;
    try {
      await beforeEffect();
      const result = await operation();
      if (result === false) throw new Error("CREDENTIAL_CHANGE_UNCONFIRMED");
      committed = true;
      if (current()) setView(previous => ({ ...previous, message: success }));
    } catch (error) {
      const code = error instanceof WebsiteCredentialError ? error.code : "";
      const preflight: Record<string, string> = {
        WEBSITE_ORIGIN_INVALID: "Enter exact HTTPS website origins without paths or wildcard domains.",
        WEBSITE_LOGIN_INVALID: "Check the login fields and authenticator setup key, then try again.",
        WEBSITE_LABEL_INVALID: "Keep passwords and verification secrets out of the login name.",
      };
      if (current()) setView(previous => ({ ...previous, uncertain: !preflight[code],
        message: preflight[code] ?? "The change was not confirmed. Refresh before trying again." }));
    } finally {
      owner.pending = false;
      if (current()) setView(previous => ({ ...previous, busy: false }));
    }
    if (committed && current()) await refresh();
    return committed && current();
  };
  return {
    ...view, locked: !allowed, owner, current, refresh, shareContext: context,
    importLegacy: () => mutate(() => SecretsVaultService.importLegacyWebsiteLogins(context()), "Earlier logins were verified in Secrets. The old encrypted records were preserved."),
    save: (input: WebsiteLoginInput, existing?: WebsiteLoginSummary) => mutate(
      () => SecretsVaultService.saveWebsiteLogin(context(), websiteLoginInput(input), existing),
      existing ? "Website login updated." : "Website login saved."),
    remove: (item: WebsiteLoginSummary) => mutate(
      () => SecretsVaultService.removeWebsiteLogin(context(), item), "Login removed from Secrets. Use Forget to remove a remembered browser session."),
    reveal: async (item: WebsiteLoginSummary) => {
      if (!current() || owner.pending) return null;
      const read = ++owner.reads;
      try {
        const result = await SecretsVaultService.readWebsiteLogin(context(), item.id);
        return current() && owner.reads === read ? result : null;
      } catch {
        if (current()) setView(previous => ({ ...previous, message: "This login could not be opened. Refresh and try again." }));
        return null;
      }
    },
  };
}

export type WebsiteLoginsModel = ReturnType<typeof useWebsiteLogins>;
