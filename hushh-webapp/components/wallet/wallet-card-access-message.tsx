"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { SettingsDetailPanel, SettingsPresentationProvider } from "@/components/profile/settings-ui";
import { WalletAccessCardDetails } from "./wallet-access-card-details";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";
import { WalletCardAccessService, type CardAccessView } from "@/lib/services/wallet-card-access-service";
import { AuthService } from "@/lib/services/auth-service";
import { useSharedCardPrivacy } from "@/lib/wallet/use-shared-card-privacy";
import { normalizePublicWalletCard, PublicWalletCardView } from "@/components/wallet-card/public-card-view";

/** A message reference is untrusted. Only the authenticated server response authorizes a view. */
export function WalletCardAccessMessage({ grantId, senderIsViewer = false }: { grantId: string; senderIsViewer?: boolean }) {
  // Native capture protection is not yet a scoped viewer capability. Keep that
  // surface unavailable instead of presenting CSS as screenshot prevention.
  const nativeViewerUnavailable = Capacitor.isNativePlatform();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ owner: string; grant: string; data: CardAccessView; deadline: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const epoch = useRef(0);
  const verifying = useRef(false);
  const focused = useRef(true);
  const view = result && result.owner === user?.uid && result.grant === grantId ? result : null;
  const close = () => { epoch.current += 1; setOpen(false); setResult(null); setBusy(false); setFailed(false); };
  useEffect(() => { epoch.current += 1; setResult(null); setOpen(false); setBusy(false); }, [user?.uid, grantId]);
  useSharedCardPrivacy(boundary => {
    if (boundary === "focus") { focused.current = true; setRefreshKey(value => value + 1); return; }
    if (boundary === "blur") focused.current = false;
    // The identity popup may blur/background the tab. Discard visible contents
    // without cancelling that operation; navigation/printing still cancels it.
    if (verifying.current && (boundary === "blur" || boundary === "hidden")) setResult(null);
    else close();
  });
  useEffect(() => () => { epoch.current += 1; }, []);
  useEffect(() => {
    if (!open || !user || senderIsViewer || nativeViewerUnavailable) return;
    let cancelled = false;
    const currentEpoch = epoch.current;
    const current = () => !cancelled && currentEpoch === epoch.current && focused.current && document.visibilityState !== "hidden";
    let pending = false;
    const refresh = async () => {
      if (pending || verifying.current || !current()) return;
      pending = true;
      const started = performance.now();
      try {
        const token = await user.getIdToken();
        if (!current()) return;
        const data = await WalletCardAccessService.view(token, grantId);
        if (!current()) return;
        const duration = Math.max(0, Date.parse(data.expiresAt) - Date.parse(data.serverNow));
        setResult({ owner: user.uid, grant: grantId, data, deadline: started + duration });
        setRemaining(Math.ceil(Math.max(0, duration - (performance.now() - started)) / 1000));
        setFailed(false);
      } catch { if (current()) { setResult(null); setFailed(true); } }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, user, grantId, senderIsViewer, nativeViewerUnavailable, refreshKey]);
  useEffect(() => {
    if (!view || view.data.status !== "active") return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((view.deadline - performance.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) setResult(previous => previous ? { ...previous, data: { ...previous.data, status: "expired", card: undefined, profileCard: undefined } } : null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [view]);
  const verify = async () => {
    if (!user || busy) return;
    const currentEpoch = ++epoch.current;
    const isCurrent = () => currentEpoch === epoch.current;
    setBusy(true);
    verifying.current = true;
    try {
      const provider = user.providerData.some(value => value.providerId === "google.com") ? "google.com" : "apple.com";
      const token = await AuthService.reauthenticateIdentity(user.uid, provider, isCurrent);
      if (!isCurrent()) return;
      await WalletCardAccessService.verify(token, grantId);
      if (!isCurrent()) return;
      setFailed(false);
      // Polling re-fetches the authorized card only after the tab is visible.

    } catch { if (isCurrent()) setFailed(true); }
    finally { verifying.current = false; if (isCurrent()) { setBusy(false); setRefreshKey(value => value + 1); } }
  };
  const card = open && remaining > 0 && view?.data.status === "active" ? view.data.card : undefined;
  const profile = open && remaining > 0 && view?.data.status === "active" && view.data.profileCard ? normalizePublicWalletCard({ ...view.data.profileCard, updatedAt: view.data.profileCard.updatedOn }) : null;
  return <div data-messages-wallet className="space-y-2 print:hidden">
    <p className="text-sm leading-[21px] font-medium">{senderIsViewer ? "You shared a card." : "A card was shared with you."}</p>
    {!senderIsViewer && !nativeViewerUnavailable ? <Button variant="secondary" size="compact" className={presentationStyles.quietAction} onClick={() => { setFailed(false); setOpen(true); }}>View card</Button> : null}
    {!senderIsViewer && nativeViewerUnavailable ? <p className="text-[13px] leading-[18px]">Open Messages in your browser to view this card.</p> : null}
    <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) close(); }} title="Shared card" mobilePresentation="sheet" surfaceClassName={`${profileStyles.walletContent} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog} messages-wallet-access-panel print:hidden`} desktopMaxWidth="820px" contentClassName="!bg-[color:var(--app-glass-surface)] backdrop-blur-[var(--blur-standard)] [&_[data-slot=dialog-header]]:text-center [&_[data-slot=dialog-header]>div]:justify-center [&_[data-slot=dialog-header]>div>div]:text-center" bodyClassName="text-center">
      <SettingsPresentationProvider density="compact" separatorInset>
        <div className="select-none" onCopy={event => event.preventDefault()} onCut={event => event.preventDefault()} onDragStart={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
          {failed ? <p role="alert" className="text-[13px] leading-[18px] text-destructive">Card unavailable. Close and try again.</p> : !view ? <p role="status">Checking access…</p> : null}
          {view?.data.status === "verification_required" ? <div className="space-y-3"><p className="text-[13px] leading-[18px]">Verify your identity to view this card.</p><Button disabled={busy} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify identity"}</Button></div> : null}
          {view?.data.status === "expired" || view?.data.status === "revoked" ? <p role="status">This access has ended.</p> : null}
          {view?.data.status === "unavailable" ? <p role="status">This card is currently unavailable.</p> : null}
          {profile ? <PublicWalletCardView embedded visualCard card={profile} /> : null}
          {card ? <>
            <p className="text-[13px] leading-[18px]">{view?.data.senderName} shared this card. {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} remaining.</p>
            <div className="mx-auto mt-4 w-full max-w-md">
              <WalletAccessCardDetails grantId={grantId} data={view!.data} />
            </div>
            <p className="mt-3 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">For you only. Do not copy or share. This card closes when you leave this window. Browsers cannot block screenshots or photos.</p>
          </> : null}
        </div>
      </SettingsPresentationProvider>
    </SettingsDetailPanel>
  </div>;
}
