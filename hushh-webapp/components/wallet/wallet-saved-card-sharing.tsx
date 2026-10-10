"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Share2 } from "@/components/icons";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { findCardShareRecipients, prepareSavedCardFile, shareSavedCard, type CardShareContext } from "@/lib/services/wallet-card-share-service";
import { WalletService, type WalletCardSummary, type WalletCardShareReceipt } from "@/lib/services/wallet-service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { resolveShareableAppOrigin } from "@/lib/share/app-origin";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import styles from "./wallet-saved-card-sharing.module.css";

export function WalletSavedCardSharing({ card, getContext, disabled }: {
  card: WalletCardSummary; getContext: (cardId: string) => CardShareContext | null; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("anyone");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preparedFile, setPreparedFile] = useState<File | null>(null);
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const generation = useRef(0);
  const dispatching = useRef(false);
  const [query, setQuery] = useState("");
  const [recipients, setRecipients] = useState<OneLocationRecipient[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<OneLocationRecipient | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [receipts, setReceipts] = useState<WalletCardShareReceipt[] | null>(null);
  const [receiptFailed, setReceiptFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const reset = useCallback(() => {
    generation.current += 1;
    setPassword(""); setConfirmation(""); setPreparedFile(null); setReaderUrl(null); setBusy(false);
    setQuery(""); setSelected(null); setRecipients([]); setLoading(false); setFailed(false);
  }, []);
  const close = useCallback(() => {
    if (dispatching.current) return;
    reset(); setOpen(false);
  }, [reset]);
  useBackLayer(ROUTES.ONE_WALLET, open ? 3 : 0, () => { close(); return true; });
  useEffect(() => { reset(); setOpen(false); }, [card.cardId, getContext, reset]);
  useEffect(() => {
    let cancelled = false;
    const context = getContext(card.cardId);
    if (!context) return;
    setReceipts(null);
    void WalletService.listCardShareReceipts({ ...context, cardId: card.cardId }).then(result => {
      if (!cancelled && context.isCurrent()) { setReceipts(result); setReceiptFailed(false); }
    }).catch(() => { if (!cancelled && context.isCurrent()) setReceiptFailed(true); });
    return () => { cancelled = true; };
  }, [card.cardId, getContext, revision]);
  useEffect(() => {
    if (!open || mode !== "hushh") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const context = getContext(card.cardId);
      if (!context) { setOpen(false); return; }
      setLoading(true); setFailed(false); setSelected(null);
      void findCardShareRecipients(context, query).then(result => {
        if (!cancelled && context.isCurrent()) { setRecipients(result.items.filter(item => item.userId !== context.userId && item.publicPersonRef)); setHasMore(result.hasMore); }
      }).catch(() => { if (!cancelled && context.isCurrent()) setFailed(true); })
        .finally(() => { if (!cancelled && context.isCurrent()) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, mode, query, card.cardId, getContext, revision]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") { reset(); setOpen(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current += 1; document.removeEventListener("visibilitychange", hide); };
  }, [reset]);
  const actionContext = () => {
    const context = getContext(card.cardId);
    const request = generation.current;
    return context ? { ...context, isCurrent: () => request === generation.current && context.isCurrent() } : null;
  };
  const prepare = async () => {
    const context = actionContext();
    if (!context || busy || password.length < 12 || password !== confirmation) return;
    setBusy(true); setPreparedFile(null);
    try {
      const origin = resolveShareableAppOrigin();
      if (!origin) throw new Error("Public reader unavailable.");
      const url = new URL(ROUTES.WALLET_CARD_OPEN, origin).toString();
      const file = await prepareSavedCardFile(context, card.cardId, password, url);
      if (context.isCurrent()) { setPreparedFile(file); setReaderUrl(url); setPassword(""); setConfirmation(""); }
    } catch { if (context.isCurrent()) morphyToast.error("Could not prepare this card. Try again."); }
    finally { if (context.isCurrent()) setBusy(false); }
  };
  const copyReaderUrl = async () => {
    if (!readerUrl || busy) return;
    try { await navigator.clipboard.writeText(readerUrl); morphyToast.success("Opening link copied."); }
    catch { morphyToast.error("Could not copy the opening link."); }
  };
  const sharePrepared = async () => {
    if (!preparedFile || dispatching.current || !getContext(card.cardId)?.isCurrent()) return;
    const request = generation.current;
    dispatching.current = true; setBusy(true);
    try {
      // Separate click after preparation retains user activation for Web Share.
      const result = await shareFile({ file: preparedFile, title: "Encrypted card" });
      morphyToast.success(result === "download" ? "Encrypted file downloaded." : "Encrypted file shared.");
      if (request === generation.current) { reset(); setOpen(false); }
    } catch (error) {
      if (!isShareCancellationError(error)) morphyToast.error("Could not share the encrypted file. Try again.");
    } finally { dispatching.current = false; setBusy(false); }
  };
  const send = async () => {
    const context = actionContext();
    if (!context || !selected || sending.current) return;
    const request = generation.current;
    sending.current = true; setBusy(true);
    try {
      const promise = shareSavedCard(context, card.cardId, selected);
      void morphyToast.promise(promise, { loading: "Sharing securely…", success: "Card shared securely.", error: (error: unknown) => error instanceof Error ? error.message : "Could not share this card." });
      const result = await promise;
      if (!context.isCurrent()) return;
      reset(); setOpen(false);
      if (result.receiptSaved) { setRevision(value => value + 1); }
      else morphyToast.info("Card sent. The recipient list could not be updated.");
    } catch { /* The action promise owns its notification. */ }
    finally { sending.current = false; if (request === generation.current) setBusy(false); }
  };
  return <SettingsPresentationProvider separatorInset density="compact">
    <section className={`${profileStyles.walletContent} space-y-4`} aria-label="Card sharing">
      <Button variant="secondary" size="compact" onClick={() => { if (!dispatching.current) { reset(); setMode("anyone"); setOpen(true); } }} disabled={disabled || busy}><Share2 className="size-4" aria-hidden="true" />Share card</Button>
      <SettingsGroup title="Shared with">
        {receipts?.length ? [...receipts].reverse().map(receipt => <SettingsRow key={receipt.messageId} title={receipt.recipientName} description="Sent encrypted card details" trailing={new Date(receipt.sentAt).toLocaleDateString()} />) : <SettingsRow title={receiptFailed ? "Could not load recipients" : receipts ? "Not shared with anyone yet" : "Loading recipients…"} />}
      </SettingsGroup>
      <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
        <DialogContent className={`${styles.dialog} max-h-[85dvh] overflow-y-auto sm:max-w-[820px]`}>
          <DialogHeader className="text-left"><DialogTitle>Share card</DialogTitle><DialogDescription>{mode === "anyone" ? "Send a password-protected file. No account needed. CVV and PIN stay private." : "Send to a connected Hushh person. CVV and PIN stay private."}</DialogDescription></DialogHeader>
          <Tabs value={mode} onValueChange={value => { if (!busy) { reset(); setMode(value); } }}>
            <TabsList className="w-full" aria-label="Share method"><TabsTrigger value="anyone" disabled={busy}>Anyone</TabsTrigger><TabsTrigger value="hushh" disabled={busy}>Hushh Chat</TabsTrigger></TabsList>
            <TabsContent value="anyone" className="space-y-4 pt-3">
              {preparedFile ? <>
                <p role="status">Encrypted file ready.</p>
                <p className={styles.hint}>Send the file and password separately. Anyone with both can open this copy.</p>
                <Button className="w-full" disabled={busy} onClick={() => void sharePrepared()}>{busy ? "Sharing…" : "Share encrypted file"}</Button>
                <Button variant="secondary" size="compact" disabled={busy} onClick={() => void copyReaderUrl()}><Copy className="size-4" aria-hidden="true" />Copy opening link</Button>
                <Button variant="secondary" size="compact" disabled={busy} onClick={() => { reset(); }}>Use another password</Button>
              </> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void prepare(); }}>
                <div className={styles.field}><label htmlFor="card-share-password">Password</label><Input id="card-share-password" type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} maxLength={256} onChange={event => { generation.current += 1; setPreparedFile(null); setBusy(false); setPassword(event.target.value); }} /></div>
                <div className={styles.field}><label htmlFor="card-share-confirmation">Confirm password</label><Input id="card-share-confirmation" type="password" autoComplete="new-password" value={confirmation} maxLength={256} onChange={event => { generation.current += 1; setPreparedFile(null); setBusy(false); setConfirmation(event.target.value); }} /></div>
                <Button type="submit" className="w-full" disabled={busy || password.length < 12 || password !== confirmation}>{busy ? "Encrypting…" : "Prepare encrypted file"}</Button>
              </form>}
              <p className={styles.hint}>Recipients open the file at <a className="text-[color:var(--app-accent)] underline" href={readerUrl ?? ROUTES.WALLET_CARD_OPEN} target="_blank" rel="noopener noreferrer">Open encrypted card</a>. Exported copies cannot be recalled.</p>
            </TabsContent>
            <TabsContent value="hushh" className="space-y-4 pt-3">
          <Input aria-label="Find a Hushh person" placeholder="Search people" value={query} onChange={event => { generation.current += 1; setSelected(null); setRecipients([]); setLoading(true); setFailed(false); setQuery(event.target.value); }} disabled={busy} />
          {loading ? <p role="status" className="text-xs text-muted-foreground">Finding people…</p> : failed ? <Button variant="secondary" size="compact" onClick={() => { setLoading(true); setRevision(value => value + 1); }}>Retry people</Button> : <div className="max-h-64 overflow-y-auto">
            {recipients.map(recipient => <button type="button" key={recipient.userId} aria-pressed={selected?.userId === recipient.userId} disabled={busy || !recipient.keyId || !recipient.publicKeyJwk} onClick={() => setSelected(recipient)} className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)] aria-pressed:bg-muted disabled:opacity-50">
              <span>{recipient.displayName}</span><span className="text-xs text-muted-foreground">{recipient.keyId && recipient.publicKeyJwk ? selected?.userId === recipient.userId ? "Selected" : "" : "Needs to unlock Hushh"}</span>
            </button>)}
            {!recipients.length ? <p className="py-3 text-xs text-muted-foreground">No people found.</p> : null}
            {hasMore ? <p className="py-2 text-xs text-muted-foreground">Search by name to find more people.</p> : null}
          </div>}
          {selected ? <p className="text-[13px]">Share {card.nickname || "this card"}, ending {card.last4}, with <strong>{selected.displayName}</strong>? They receive a copy in Chat.</p> : null}
          <Button disabled={!selected || busy || loading} onClick={() => void send()}>{busy ? "Sharing…" : "Share securely"}</Button>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </section>
  </SettingsPresentationProvider>;
}
