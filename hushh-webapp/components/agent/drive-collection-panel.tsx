"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { DrivePacketCatalog, useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import { DrivePacketService, type DriveCollectionStatus, type PacketGuard } from "@/lib/services/drive-packet-service";

// What the row says while preparation is on. Off has its own caption, so an
// On caption never sits beside an Off switch.
const working: Record<Exclude<DriveCollectionStatus["state"], "not_enabled">, string> = {
  paused: "Paused while Background Drive access is off.", unable_to_verify: "Can’t check Drive right now.",
  indexing: "Agent One is preparing your packets.", incomplete: "Some files need another attempt.", ready: "Your packets are up to date.",
};
/** A read that failed, or the direction of a change that failed. */
type Failure = "read" | "on" | "off";
function caption(status: DriveCollectionStatus | null, backgroundEnabled: boolean | null, busy: boolean, failure: Failure | null): string {
  if (busy) return "Saving…";
  if (failure === "read") return "Couldn’t check preparation.";
  if (failure) return `Couldn’t turn ${failure}. Try again.`;
  if (!status) return "Checking preparation…";
  if (!status.enabled || status.state === "not_enabled") {
    return backgroundEnabled === false ? "Turn on Background Drive access first." : "Agent One won’t prepare new packets.";
  }
  return backgroundEnabled === false ? working.paused : working[status.state];
}
function duration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function DriveCollectionPanel({ backgroundEnabled }: { backgroundEnabled: boolean | null }) {
  const session = useDrivePacketSession("collection");
  if (!session.token) return null;
  return <CollectionPanel key={session.key} token={session.token} guard={session.guard} backgroundEnabled={backgroundEnabled} />;
}

function CollectionPanel({ token, guard, backgroundEnabled }: {
  token: string; guard: PacketGuard; backgroundEnabled: boolean | null;
}) {
  const [status, setStatus] = useState<DriveCollectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [revision, setRevision] = useState(0);
  const serial = useRef(0);
  const lock = useRef(false);
  const read = useCallback(async () => {
    if (lock.current) return;
    const attempt = ++serial.current;
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try {
      const result = await DrivePacketService.collection(token, current);
      current(); setStatus(result); setError(null); setRevision(value => value + 1);
    } catch { try { current(); setError("read"); } catch { /* Superseded owner. */ } }
  }, [guard, token]);
  useEffect(() => {
    // A renewed owner token invalidates pending I/O without leaving its spinner
    // mounted indefinitely. Account/epoch changes already remount this panel.
    serial.current += 1;
    lock.current = false;
    setBusy(false);
    return () => { serial.current += 1; };
  }, [guard]);
  useEffect(() => {
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !lock.current) void read(); }, 15000);
    return () => { clearInterval(timer); };
  }, [backgroundEnabled, read]);
  const toggle = async () => {
    if (!status || lock.current) return;
    const next = !status.enabled;
    const attempt = ++serial.current;
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try { current(); } catch { return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await DrivePacketService.setProcessing(token, next, current);
      current(); setStatus(result); setRevision(value => value + 1);
    } catch { try { current(); setError(next ? "on" : "off"); } catch { /* Superseded owner. */ } }
    finally { if (attempt === serial.current) lock.current = false; try { current(); setBusy(false); } catch { /* Superseded owner. */ } }
  };
  const paused = backgroundEnabled === false || status?.state === "paused";
  return <section aria-label="Drive document preparation" className="space-y-3">
    <SettingsGroup density="compact">
      <SettingsRow title="Prepare packets" description={caption(status, backgroundEnabled, busy, error)}
        trailing={status ? <Switch size="ios" aria-label="Prepare packets" checked={status.enabled}
          disabled={busy || !status.enabled && backgroundEnabled !== true} onCheckedChange={() => void toggle()} /> : null} />
      {status && <details className="px-4 pb-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">View details</summary>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{(["discovered", "indexed", "pending", "failed"] as const).map(name => <div key={name}><dt className="text-xs capitalize text-muted-foreground">{name}</dt><dd className="font-medium tabular-nums">{status.counts[name].toLocaleString()}</dd></div>)}</dl>
        <p className="mt-3">{status.lastIndexedAt ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString()}` : "No files indexed yet."}{status.initialIndexingDurationMs !== null ? ` · Initial indexing ${duration(status.initialIndexingDurationMs)}` : status.initialStartedAt && status.state === "indexing" ? " · Initial indexing in progress" : ""}</p>
        <p>Discovery work: {duration(status.syncDurationMs)}. Last sync: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Not completed"}.</p>
        <p>Text extracted: {status.counts.extracted.toLocaleString()} files{status.initialExtractionDurationMs !== null ? ` · Initial extraction ${duration(status.initialExtractionDurationMs)}` : ""}. Indexed files have completed document understanding.</p>
        {paused && <p>Saved packets were last verified before preparation paused.</p>}
      </details>}
      {error && <Button size="compact" variant="ghost" disabled={busy} onClick={() => void read()}>Retry preparation</Button>}
    </SettingsGroup>
    {status && <DrivePacketCatalog refreshKey={revision} preparationPaused={paused || !status.enabled} />}
  </section>;
}
