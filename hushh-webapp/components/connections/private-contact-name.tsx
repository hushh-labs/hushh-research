"use client";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { loadContactNames, saveContactName } from "@/lib/connections/private-contact-names";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function PrivateContactName({ personRef }: { personRef: string }) {
  const { user, userId } = useAuth();
  const vault = useVault();
  const latest = useRef({ vault, personRef });
  useLayoutEffect(() => { latest.current = { vault, personRef }; }, [vault, personRef]);
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<{ epoch: number; personRef: string; loaded: boolean; status?: string } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = vault.vaultKey, token = vault.vaultOwnerToken;
  useEffect(() => {
    let active = true;
    if (!userId || !key || !token) return;
    const generation = getAuthSessionGeneration();
    const isCurrent = () => active && mounted.current && latest.current.personRef === personRef && epoch === snapshotVaultSessionEpoch() && generation === getAuthSessionGeneration() && latest.current.vault.getVaultKey() === key;
    void loadContactNames({ userId, vaultKey: key, vaultOwnerToken: token, isCurrent }).then(names => {
      if (!isCurrent()) return;
      setDraft(names.items.find(item => item.personRef === personRef)?.alias ?? "");
      setState({ epoch, personRef, loaded: true });
    }).catch(() => { if (isCurrent()) setState({ epoch, personRef, loaded: false, status: "Private name unavailable" }); });
    return () => { active = false; };
  }, [userId, key, token, epoch, personRef]);
  const loaded = state?.epoch === epoch && state.personRef === personRef && state.loaded && key && token;
  async function save() {
    if (!user || !userId || !key || !token || !loaded || pending.current) return;
    const generation = getAuthSessionGeneration();
    const isCurrent = () => mounted.current && latest.current.personRef === personRef && epoch === snapshotVaultSessionEpoch() && generation === getAuthSessionGeneration() && latest.current.vault.getVaultKey() === key && latest.current.vault.getVaultOwnerToken() === token;
    pending.current = true;
    try {
      const saved = await saveContactName({ userId, personRef, alias: draft, vaultKey: key, vaultOwnerToken: token, getIdToken: () => user.getIdToken(), isCurrent });
      if (isCurrent()) setState({ epoch, personRef, loaded: true, status: saved ? "Private name saved" : "Couldn't save" });
    } catch { if (isCurrent()) setState({ epoch, personRef, loaded: true, status: "Couldn't save" }); }
    finally { pending.current = false; }
  }
  if (!key || !token) return null;
  return <div className="space-y-1"><div className="flex items-center gap-2">
    <Input aria-label="Private name" placeholder="Private name" maxLength={64} disabled={!loaded} value={loaded ? draft : ""} onChange={event => setDraft(event.target.value)} className="min-h-11" />
    <Button variant="ghost" disabled={!loaded} onClick={() => void save()}>Save</Button>
  </div>{state?.epoch === epoch && state.personRef === personRef && state.status ? <p role="status" className="text-xs text-muted-foreground">{state.status}</p> : null}</div>;
}
