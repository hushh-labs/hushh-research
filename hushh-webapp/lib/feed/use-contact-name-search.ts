"use client";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useVault } from "@/lib/vault/vault-context";
import { loadContactNames, matchContactName } from "@/lib/connections/private-contact-names";
import { ConnectionsService } from "@/lib/services/connections-service";

/** A private owner-authored alias binds a verified person; it never rewrites their identity. */
export function useContactNameSearch(owner: string) {
  const vault = useVault();
  const currentVault = useRef(vault);
  useLayoutEffect(() => { currentVault.current = vault; }, [vault]);
  return useCallback(async (query: string, idToken: string, current: () => boolean): Promise<{ query: string; personRef?: string; personUserId?: string; privateNamesUnavailable?: boolean }> => {
    const { getVaultKey, getVaultOwnerToken } = currentVault.current;
    const key = getVaultKey(), token = getVaultOwnerToken();
    if (!query.trim() || !key || !token) return { query };
    const isCurrent = () => current() && currentVault.current.getVaultKey() === key && currentVault.current.getVaultOwnerToken() === token;
    let names;
    try { names = await loadContactNames({ userId: owner, vaultKey: key, vaultOwnerToken: token, isCurrent }); }
    catch { if (!isCurrent()) throw new DOMException("Search access changed", "AbortError"); return { query, privateNamesUnavailable: true }; }
    const match = matchContactName(query, names);
    if (!match) return { query };
    const connections = await ConnectionsService.listConnections({ idToken });
    if (!isCurrent()) throw new DOMException("Search access changed", "AbortError");
    const confirmed = connections.filter(person => person.publicPersonRef === match.personRef);
    if (confirmed.length !== 1) return { query };
    return { query: match.query, personRef: match.personRef, personUserId: confirmed[0]!.userId };
  }, [owner]);
}
