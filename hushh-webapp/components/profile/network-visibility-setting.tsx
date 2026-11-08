"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/profile/settings-ui";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { ConnectionsService } from "@/lib/services/connections-service";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { dispatchConnectionGraphChanged } from "@/lib/connections/connection-graph-events";

export function NetworkVisibilitySetting() {
  const { user, userId } = useAuth();
  const generation = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  return user && userId ? <VisibilitySession key={`${userId}:${generation}`} /> : null;
}
function VisibilitySession() {
  const { user, userId } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const generation = getAuthSessionGeneration();
    setBusy(true); setError(null);
    void user.getIdToken().then(idToken => ConnectionsService.getNetworkVisibility({ idToken, signal: controller.signal }))
      .then(value => { if (!controller.signal.aborted && generation === getAuthSessionGeneration()) setEnabled(value.shareConnectionList === true); })
      .catch(() => { if (!controller.signal.aborted && generation === getAuthSessionGeneration()) setError("Could not load network visibility."); })
      .finally(() => { if (!controller.signal.aborted && generation === getAuthSessionGeneration()) setBusy(false); });
    return () => controller.abort();
  }, [user, revision]);
  const update = async (value: boolean) => {
    if (!user || !userId || busy) return;
    const generation = getAuthSessionGeneration();
    setBusy(true); setError(null);
    try {
      const idToken = await user.getIdToken();
      if (!mounted.current || generation !== getAuthSessionGeneration()) return;
      const result = await ConnectionsService.updateNetworkVisibility({ idToken, shareConnectionList: value });
      if (!mounted.current || generation !== getAuthSessionGeneration()) return;
      setEnabled(result.shareConnectionList === true); dispatchConnectionGraphChanged(userId);
    } catch { if (mounted.current && generation === getAuthSessionGeneration()) setError("Could not save network visibility. Your preference has not been confirmed."); }
    finally { if (mounted.current && generation === getAuthSessionGeneration()) setBusy(false); }
  };
  return <div><SettingsRow icon={PROFILE_ICONS.people} iconTone="capability" title="Share my connection list" description="Allow your active direct connections to browse your connections. Shared connections also contribute anonymous extended-network degree labels. This does not share private contacts or grant access to your information." trailing={<Switch data-voice-control-id="network-share-connection-list" aria-label="Share my connection list" checked={enabled} disabled={busy || Boolean(error)} onCheckedChange={value => void update(value)} />} />
    {error ? <p role="alert" className="px-4 text-sm text-muted-foreground">{error} <button type="button" className="min-h-11 px-2 underline" onClick={() => setRevision(value => value + 1)}>Retry</button></p> : null}
  </div>;
}
