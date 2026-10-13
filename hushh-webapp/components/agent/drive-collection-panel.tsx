"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DrivePacketCatalog, useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import { DrivePacketService, type DriveCollectionStatus, type PacketGuard } from "@/lib/services/drive-packet-service";

const states: Record<DriveCollectionStatus["state"], string> = {
  not_enabled: "Not enabled", paused: "Paused", unable_to_verify: "Unable to verify",
  indexing: "Indexing", incomplete: "Incomplete", ready: "Up to date",
};
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
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const serial = useRef(0);
  const lock = useRef(false);
  const read = useCallback(async () => {
    if (lock.current) return;
    const attempt = ++serial.current;
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try {
      const result = await DrivePacketService.collection(token, current);
      current(); setStatus(result); setError(false); setRevision(value => value + 1);
    } catch { try { current(); setError(true); } catch { /* Superseded owner. */ } }
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
    const attempt = ++serial.current;
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try { current(); } catch { return; }
    lock.current = true; setBusy(true); setError(false);
    try {
      const result = await DrivePacketService.setProcessing(token, !status.enabled, current);
      current(); setStatus(result); setRevision(value => value + 1);
    } catch { try { current(); setError(true); } catch { /* Superseded owner. */ } }
    finally { if (attempt === serial.current) lock.current = false; try { current(); setBusy(false); } catch { /* Superseded owner. */ } }
  };
  const paused = backgroundEnabled === false || status?.state === "paused";
  return <section aria-label="Drive document preparation" className="space-y-4 rounded-2xl bg-foreground/5 px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Prepare document packets</h3>
      <span className="text-xs text-muted-foreground">{paused ? "Paused" : status ? states[status.state] : "Checking…"}</span></div>
    {!status?.enabled && <p className="text-xs text-muted-foreground">Allow your private agent to read and index supported Drive files, send relevant text to Gemini, and prepare packets while background access is on. Publishing and sharing need separate permission.</p>}
    {status && <>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{(["discovered", "indexed", "pending", "failed"] as const).map(name => <div key={name}><dt className="text-xs capitalize text-muted-foreground">{name}</dt><dd className="font-medium tabular-nums">{status.counts[name].toLocaleString()}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">{status.lastIndexedAt ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString()}` : "No files indexed yet."}{status.initialIndexingDurationMs !== null ? ` · Initial indexing ${duration(status.initialIndexingDurationMs)}` : status.initialStartedAt && status.state === "indexing" ? " · Initial indexing in progress" : ""}</p>
      {paused && <p className="text-xs text-muted-foreground">Background processing is paused. Saved information has not been freshly verified.</p>}
      <Button size="compact" variant={status.enabled ? "outline" : "default"} disabled={busy || !status.enabled && backgroundEnabled !== true} onClick={() => void toggle()}>{busy ? "Saving…" : status.enabled ? "Pause preparation" : "Allow preparation"}</Button>
      {!status.enabled && backgroundEnabled === false && <p className="text-xs text-muted-foreground">Turn on background Drive access to start.</p>}
      <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">View details</summary><p>Discovery work: {duration(status.syncDurationMs)}. Last sync: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Not completed"}.</p><p>Text extracted: {status.counts.extracted.toLocaleString()} files{status.initialExtractionDurationMs !== null ? ` · Initial extraction ${duration(status.initialExtractionDurationMs)}` : ""}. Indexed files have completed document understanding. Ready packets are counted separately.</p></details>
    </>}
    {error && <p role="status" className="text-sm">Couldn’t check preparation. <Button size="compact" variant="ghost" disabled={busy} onClick={() => void read()}>Retry preparation</Button></p>}
    {status?.enabled && <DrivePacketCatalog refreshKey={revision} />}
  </section>;
}
