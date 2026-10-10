"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { SettingsDetailPanel, SettingsGroup, SettingsRow, SettingsPresentationProvider } from "@/components/profile/settings-ui";
import { ProfilePaneCardIcon, ProfilePaneCalendarIcon, ProfilePaneCardNetworkIcon, ProfilePaneGlobeIcon } from "@/components/profile/profile-pane-icons";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { WalletCardAccessService, type CardAccessView } from "@/lib/services/wallet-card-access-service";
import { AuthService } from "@/lib/services/auth-service";

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
  const epoch = useRef(0);
  const view = result && result.owner === user?.uid && result.grant === grantId ? result : null;
  const close = () => { epoch.current += 1; setOpen(false); setResult(null); setBusy(false); setFailed(false); };
  useEffect(() => { epoch.current += 1; setResult(null); setOpen(false); setBusy(false); }, [user?.uid, grantId]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") close(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", close);
    return () => { epoch.current += 1; document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", close); };
  }, []);
  useEffect(() => {
    if (!open || !user || senderIsViewer || nativeViewerUnavailable) return;
    let cancelled = false;
    const currentEpoch = epoch.current;
    const current = () => !cancelled && currentEpoch === epoch.current && document.visibilityState !== "hidden";
    let pending = false;
    const refresh = async () => {
      if (pending || !current()) return;
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
  }, [open, user, grantId, senderIsViewer, nativeViewerUnavailable]);
  useEffect(() => {
    if (!view || view.data.status !== "active") return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((view.deadline - performance.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) setResult(previous => previous ? { ...previous, data: { ...previous.data, status: "expired", card: undefined } } : null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [view]);
  const verify = async () => {
    if (!user || busy) return;
    const currentEpoch = epoch.current;
    const isCurrent = () => currentEpoch === epoch.current;
    setBusy(true);
    try {
      const provider = user.providerData.some(value => value.providerId === "google.com") ? "google.com" : "apple.com";
      const token = await AuthService.reauthenticateIdentity(user.uid, provider, isCurrent);
      if (!isCurrent()) return;
      await WalletCardAccessService.verify(token, grantId);
    } catch { if (isCurrent()) setFailed(true); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const card = open && remaining > 0 && view?.data.status === "active" ? view.data.card : undefined;
  return <div className="space-y-2 print:hidden">
    <p className="text-sm">{senderIsViewer ? "You shared a card." : "A card was shared with you."}</p>
    {!senderIsViewer && !nativeViewerUnavailable ? <Button variant="secondary" size="compact" onClick={() => { setFailed(false); setOpen(true); }}>View card</Button> : null}
    {!senderIsViewer && nativeViewerUnavailable ? <p className="text-xs">Open Messages in your browser to view this card.</p> : null}
    <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) close(); }} title="Shared card" mobilePresentation="sheet" surfaceClassName={`${profileStyles.walletContent} print:hidden`} desktopMaxWidth="820px">
      <SettingsPresentationProvider density="compact" separatorInset>
        <div className="select-none" onCopy={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
          {failed ? <p role="alert" className="text-xs">Card unavailable. Close and try again.</p> : !view ? <p role="status">Checking access…</p> : null}
          {view?.data.status === "verification_required" ? <div className="space-y-3"><p className="text-xs">Verify your identity to view this card.</p><Button disabled={busy} onClick={() => void verify()}>{busy ? "Verifying…" : "Verify identity"}</Button></div> : null}
          {view?.data.status === "expired" || view?.data.status === "revoked" ? <p role="status">This access has ended.</p> : null}
          {card ? <>
            <p className="text-xs">{view?.data.senderName} shared this card. {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} remaining.</p>
            <SettingsGroup title="Card details">
              <SettingsRow icon={ProfilePaneCardIcon} iconTone="transparent" title="Card number" trailing={`•••• ${card.last4}`} />
              <SettingsRow icon={ProfilePaneCardNetworkIcon} iconTone="transparent" title="Card network" trailing={card.brand} />
              <SettingsRow icon={ProfilePaneCalendarIcon} iconTone="transparent" title="Expiry" trailing={`${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`} />
              <SettingsRow icon={ProfilePaneGlobeIcon} iconTone="transparent" title="Issuing region" trailing={card.issuingRegion || "Not provided"} />
            </SettingsGroup>
          </> : null}
        </div>
      </SettingsPresentationProvider>
    </SettingsDetailPanel>
  </div>;
}
