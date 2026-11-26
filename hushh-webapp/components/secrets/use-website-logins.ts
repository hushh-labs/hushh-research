"use client";

import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { CredentialsVaultService, createOwnerCredentialCustodyPort } from "@/lib/pkm/credentials-vault-service";
import { CredentialError, credentialInput } from "@/lib/pkm/credentials-contracts";
import type { CredentialInput, CredentialSummary } from "@/lib/pkm/credentials-contracts";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

type View = {
  items: CredentialSummary[];
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
  const allowed = !!userId && !!vaultKey && !!getVaultOwnerToken() && !privacy?.shielded && privacy?.appIsActive !== false &&
    (!Capacitor.isNativePlatform() || !!privacy) && (typeof document === "undefined" || document.visibilityState !== "hidden");
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
      !observation?.shielded && observation?.appIsActive !== false && (!Capacitor.isNativePlatform() || !!observation);
  }, [owner, userId, epoch, getVaultKey, getVaultOwnerToken]);
  const [view, setView] = useOwnerPresentationState(owner, EMPTY);
  const beforeEffect = useCallback(async () => { if (!current()) throw new Error("CREDENTIAL_OWNER_RETIRED"); }, [current]);
  const context = useCallback(() => {
    const vaultOwnerToken = getVaultOwnerToken();
    if (!current() || !userId || !vaultKey || !vaultOwnerToken) throw new Error("CREDENTIAL_OWNER_RETIRED");
    return { userId, vaultKey, vaultOwnerToken, beforeEffect };
  }, [current, userId, vaultKey, getVaultOwnerToken, beforeEffect]);
  const writeContext = async (needsCustody: boolean, custodyGrantDurationHours = 24) => {
    const value = { ...context(), custodyGrantDurationHours };
    if (!needsCustody) return value;
    const custody = await createOwnerCredentialCustodyPort(value);
    await beforeEffect();
    return { ...value, custody };
  };
  const refresh = useCallback(async () => {
    if (!current() || owner.pending) return;
    const read = ++owner.reads;
    setView(previous => ({ ...previous, loading: true, failed: false }));
    try {
      const items = await CredentialsVaultService.list(context());
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
      const code = error instanceof CredentialError ? error.code : "";
      if (code === "CREDENTIAL_SAVED_CUSTODY_PENDING") committed = true;
      const preflight: Record<string, string> = {
        CREDENTIAL_CUSTODY_UNAVAILABLE: "Connect your private agent before enabling automatic sign-in, or choose unlocked-vault-only access.",
        CREDENTIAL_SESSION_ONLY: "Session-only lockdown is on. Change that setting before enabling agent custody, or choose unlocked-vault-only access.",
        CREDENTIAL_ORIGIN_INVALID: "Enter exact public HTTPS origins, without paths, ports or wildcard domains.",
        CREDENTIAL_INVALID: "Check the login fields and authenticator setup key, then try again.",
        CREDENTIAL_LABEL_INVALID: "Keep passwords and verification secrets out of the login name.",
        CREDENTIAL_HINT_INVALID: "The username hint must not contain the username or password.",
      };
      if (current()) setView(previous => ({ ...previous, uncertain: !committed && !preflight[code],
        message: preflight[code] ?? (code === "CREDENTIAL_SAVED_CUSTODY_PENDING"
          ? "The login is saved, but private-agent access was not confirmed. Refresh, then renew its access."
          : "The change was not confirmed. Refresh before trying again.") }));
    } finally {
      owner.pending = false;
      if (current()) setView(previous => ({ ...previous, busy: false }));
    }
    if (committed && current()) await refresh();
    return committed && current();
  };
  return {
    ...view, locked: !allowed, owner, current, refresh, shareContext: context,
    save: (input: CredentialInput, existing?: CredentialSummary, durationHours = 24) => mutate(
      async () => {
        const checked = credentialInput(input);
        return CredentialsVaultService.save(await writeContext(checked.autonomyPolicy !== "vault_only" || !!existing && existing.autonomyPolicy !== "vault_only", durationHours),
          checked, existing ? { id: existing.id, expectedRevision: existing.revision } : {});
      },
      existing ? "Website login updated." : "Website login saved."),
    remove: (item: CredentialSummary) => mutate(
      async () => CredentialsVaultService.remove(await writeContext(item.autonomyPolicy !== "vault_only"), item.id, item.revision), "Saved login removed. Remembered browser sessions are managed separately with Forget."),
    renew: (item: CredentialSummary, durationHours = 24) => mutate(
      async () => CredentialsVaultService.rotate(await writeContext(true, durationHours), item.id, item.revision), "Private-agent access renewed."),
    reveal: async (item: CredentialSummary) => {
      if (!current() || owner.pending) return null;
      const read = ++owner.reads;
      try {
        const result = await CredentialsVaultService.reveal(context(), item.id);
        return current() && owner.reads === read ? result : null;
      } catch {
        if (current()) setView(previous => ({ ...previous, message: "This login could not be opened. Refresh and try again." }));
        return null;
      }
    },
  };
}

export type WebsiteLoginsModel = ReturnType<typeof useWebsiteLogins>;
