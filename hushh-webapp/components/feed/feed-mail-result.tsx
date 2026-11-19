"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { Button } from "@/components/ui/button";
import { ActivityCard } from "@/components/gmail/gmail-request-cards";
import { GmailInformationRequestsService, type GmailInformationRequestWorkflow } from "@/lib/services/gmail-information-requests-service";
import { EmailDeliveryService, type EmailSendStatus } from "@/lib/services/email-delivery-service";
import type { FeedMailSelection } from "@/lib/feed/mail-result-selection";
const VaultUnlockDialog = dynamic(() => import("@/components/vault/vault-unlock-dialog").then(module => module.VaultUnlockDialog), { ssr: false });
const sendLabels: Record<EmailSendStatus["state"], string> = { prepared: "Not sent", sending: "Sending", sent: "Message sent", failed: "Message wasn't sent", outcome_unknown: "Delivery unconfirmed", expired: "Send expired", cancelled: "Send cancelled" };

/** Read the exact source. Opening history never prepares, reconciles, or sends. */
export function FeedMailResult({ selection, getToken, isCurrent }: { selection: FeedMailSelection; getToken: () => Promise<string>; isCurrent: () => boolean }) {
  const { user } = useAuth();
  const vault = useVault();
  const currentVault = useRef(vault);
  useLayoutEffect(() => { currentVault.current = vault; }, [vault]);
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const token = vault.vaultOwnerToken;
  const selectionKey = `${selection.kind}:${selection.id}`;
  const episode = useRef(0);
  const invalidateEpisode = useCallback(() => { episode.current++; }, []);
  const [unlock, setUnlock] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ epoch: number; token: string; selectionKey: string; workflow?: GmailInformationRequestWorkflow; send?: EmailSendStatus; failed?: boolean } | null>(null);
  useEffect(() => {
    const request = ++episode.current;
    const current = () => request === episode.current && isCurrent() && snapshotVaultSessionEpoch() === epoch && currentVault.current.getVaultOwnerToken() === token;
    if (!token) return;
    void (async () => {
      try {
        const firebaseIdToken = await getToken();
        if (!current()) return;
        const auth = { firebaseIdToken, vaultOwnerToken: token };
        const result = selection.kind === "request"
          ? { workflow: await GmailInformationRequestsService.getActivity({ ...auth, workflowId: selection.id }) }
          : { send: await EmailDeliveryService.readSendStatus({ ...auth, actionId: selection.id }) };
        if (current()) setState({ epoch, token, selectionKey, ...result });
      } catch { if (current()) setState({ epoch, token, selectionKey, failed: true }); }
    })();
    return invalidateEpisode;
  }, [selection.kind, selection.id, getToken, isCurrent, epoch, token, retry, selectionKey, invalidateEpisode]);
  const visible = state?.epoch === epoch && state.token === token && state.selectionKey === selectionKey && isCurrent() ? state : null;
  if (!token) return <><Button variant="secondary" onClick={() => setUnlock(true)}>Unlock to view</Button>
    {user && unlock ? <VaultUnlockDialog user={user} open onOpenChange={setUnlock} onSuccess={() => setUnlock(false)} allowVaultCreation={false} title="Unlock your vault" description="View this result securely." /> : null}</>;
  if (!visible) return <p role="status" className="text-sm text-muted-foreground">Checking result…</p>;
  if (visible.failed) return <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Source result unavailable</p><Button variant="ghost" onClick={() => { setState(null); setRetry(value => value + 1); }}>Try again</Button></div>;
  if (visible.workflow) return <ActivityCard workflow={visible.workflow} showTimestamp={false} />;
  return visible.send ? <p className="text-sm">{sendLabels[visible.send.state]}</p> : null;
}
