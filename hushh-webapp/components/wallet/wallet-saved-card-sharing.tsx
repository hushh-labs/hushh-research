"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProfilePaneInviteIcon, ProfilePaneSecurityIcon } from "@/components/profile/profile-pane-icons";
import { SettingsDetailPanel, SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { WalletCardAccessService, type CardAccessRecipient, type CardAccessState } from "@/lib/services/wallet-card-access-service";
import { WalletService, type WalletCardSummary, type WalletCardShareReceipt } from "@/lib/services/wallet-service";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import styles from "./wallet-saved-card-sharing.module.css";

export function WalletSavedCardSharing({ card, getContext, disabled }: {
  card: WalletCardSummary; getContext: (cardId: string) => CardShareContext | null; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recipients, setRecipients] = useState<CardAccessRecipient[]>([]);
  const [selected, setSelected] = useState<Record<string, CardAccessRecipient>>({});
  const [duration, setDuration] = useState<5 | 10 | 15>(10);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<CardAccessState | null>(null);
  const [stateFailed, setStateFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [receipts, setReceipts] = useState<WalletCardShareReceipt[]>([]);
  const generation = useRef(0);
  const sending = useRef(false);
  // Keep this key across uncertain delivery retries, never extend the original grant.
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const close = useCallback(() => {
    generation.current += 1;
    setOpen(false); setQuery(""); setSelected({}); setRecipients([]); setBusy(false);
  }, []);
  useBackLayer(ROUTES.ONE_WALLET, open ? 3 : 0, () => { close(); return true; });
  useEffect(() => { close(); setState(null); setReceipts([]); attempt.current = null; }, [card.cardId, getContext, close]);
  useEffect(() => {
    let cancelled = false;
    const context = getContext(card.cardId);
    if (!context) return;
    setStateFailed(false);
    void WalletCardAccessService.state(context, card.cardId).then(result => {
      if (!cancelled && context.isCurrent()) setState(result);
    }).catch(() => { if (!cancelled && context.isCurrent()) { setState(null); setStateFailed(true); } });
    void WalletService.listCardShareReceipts({ ...context, cardId: card.cardId }).then(result => {
      if (!cancelled && context.isCurrent()) setReceipts(result);
    }).catch(() => { /* Historical copies never determine current grant state. */ });
    return () => { cancelled = true; };
  }, [card.cardId, getContext, revision]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setFailed(false);
    const timer = window.setTimeout(() => {
      const context = getContext(card.cardId);
      if (!context) { close(); return; }
      void WalletCardAccessService.recipients(context, query).then(result => {
        if (!cancelled && context.isCurrent()) { setRecipients(result.items); setHasMore(result.hasMore); }
      }).catch(() => { if (!cancelled && context.isCurrent()) setFailed(true); })
        .finally(() => { if (!cancelled && context.isCurrent()) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query, card.cardId, getContext, revision, close]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") close(); };
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current += 1; document.removeEventListener("visibilitychange", hide); };
  }, [close]);
  const send = async () => {
    const base = getContext(card.cardId);
    const refs = Object.keys(selected).sort();
    if (!base || !refs.length || sending.current) return;
    const requestGeneration = generation.current;
    const context = { ...base, isCurrent: () => requestGeneration === generation.current && base.isCurrent() };
    const fingerprint = JSON.stringify([base.userId, card.cardId, refs, duration]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    sending.current = true; setBusy(true);
    try {
      if (!state?.eligible) await WalletService.prepareCardSharing({ ...context, cardId: card.cardId });
      if (!context.isCurrent()) return;
      await WalletCardAccessService.share(context, card.cardId, refs, duration, attempt.current.id);
      if (!context.isCurrent()) return;
      attempt.current = null; close(); setRevision(value => value + 1);
      morphyToast.success("Card shared.");
    } catch { if (context.isCurrent()) morphyToast.error("Could not confirm sharing. Retry to check the same request."); }
    finally { sending.current = false; if (context.isCurrent()) setBusy(false); }
  };
  const revoke = async (id: string) => {
    const context = getContext(card.cardId);
    if (!context || busy) return;
    setBusy(true);
    try {
      await WalletCardAccessService.revoke(context, id);
      if (context.isCurrent()) { setRevision(value => value + 1); morphyToast.success("Access revoked."); }
    } catch { if (context.isCurrent()) morphyToast.error("Could not revoke access. Try again."); }
    finally { if (context.isCurrent()) setBusy(false); }
  };
  return <SettingsPresentationProvider separatorInset density="compact">
    <section className={`${profileStyles.walletContent} space-y-4`} aria-label="Card sharing">
      <SettingsGroup title="Sharing">
        <SettingsRow icon={ProfilePaneInviteIcon} iconTone="transparent" title="Share card"
          description="Temporary access for your connections."
          chevron onClick={() => setOpen(true)} disabled={disabled || busy} />
        {stateFailed ? <SettingsRow title="Retry" onClick={() => setRevision(value => value + 1)} /> : null}
      </SettingsGroup>
      <SettingsGroup title="Shared with">
        {state?.grants.length ? state.grants.map(grant => <SettingsRow key={grant.id} icon={ProfilePaneInviteIcon} iconTone="transparent"
          title={grant.recipientName} description={grant.status === "active" ? `Until ${new Date(grant.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : grant.status === "revoked" ? "Access revoked" : "Access expired"}
          trailing={grant.status === "active" ? <Button variant="secondary" size="compact" disabled={busy} onClick={() => void revoke(grant.id)}>Revoke</Button> : undefined} />)
          : <SettingsRow icon={ProfilePaneInviteIcon} iconTone="transparent" title={stateFailed ? "Could not load shared access." : state ? "No active shares" : "Loading shares…"} />}
      </SettingsGroup>
      {receipts.length ? <SettingsGroup title="Previously sent copies">
        {[...receipts].reverse().map(receipt => <SettingsRow key={receipt.messageId} icon={ProfilePaneInviteIcon} iconTone="transparent" title={receipt.recipientName}
          description="Sent copy · cannot be recalled" trailing={new Date(receipt.sentAt).toLocaleDateString()} />)}
      </SettingsGroup> : null}
      <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) close(); }} title="Share card" description="Share masked card details with your connections."
        mobilePresentation="sheet" desktopMaxWidth="820px" surfaceClassName={`${profileStyles.walletContent} ${styles.accessSurface}`}
        footer={<Button className="w-full" disabled={busy || !Object.keys(selected).length} onClick={() => void send()}>{busy ? "Sharing…" : `Share with ${Object.keys(selected).length}`}</Button>}>
        <div className="space-y-4">
          <Input aria-label="Search connections" placeholder="Search connections" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
          <div className="max-h-64 overflow-y-auto" aria-label="Connections">
            {loading ? <p role="status">Finding connections…</p> : failed ? <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>Retry connections</Button> : recipients.map(recipient => <label key={recipient.personRef} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-[13px]">
              <Avatar className="size-8"><AvatarImage src={recipient.photoUrl || undefined} alt="" /><AvatarFallback>{recipient.displayName.slice(0, 1)}</AvatarFallback></Avatar>
              <span className="min-w-0 flex-1 break-words">{recipient.displayName}{recipient.trusted ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><ProfilePaneSecurityIcon size={14} />Trusted Circle</span> : null}</span>
              <Checkbox aria-label={`Share with ${recipient.displayName}`} checked={Boolean(selected[recipient.personRef])} disabled={busy}
                onCheckedChange={checked => setSelected(previous => { const next = { ...previous }; if (checked === true) next[recipient.personRef] = recipient; else delete next[recipient.personRef]; return next; })} />
            </label>)}
            {!loading && !failed && !recipients.length ? <p className="py-3 text-xs text-muted-foreground">No connections found.</p> : null}
            {hasMore ? <p className="text-xs text-muted-foreground">Search by name to find more connections.</p> : null}
          </div>
          <fieldset><legend className="mb-2 text-[13px]">Access time</legend><div className="flex gap-2">{([5, 10, 15] as const).map(minutes => <Button key={minutes} variant={duration === minutes ? "default" : "secondary"} size="compact" aria-pressed={duration === minutes} disabled={busy} onClick={() => setDuration(minutes)}>{minutes} minutes</Button>)}</div></fieldset>
          <p className="text-xs text-muted-foreground">People outside your Trusted Circle verify their identity before viewing. CVV and PIN stay private.</p>
        </div>
      </SettingsDetailPanel>
    </section>
  </SettingsPresentationProvider>;
}
