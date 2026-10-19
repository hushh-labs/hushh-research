"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { DrivePacketCatalog, useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import { DrivePacketService, type DriveCollectionStatus } from "@/lib/services/drive-packet-service";

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

type CollectionValue = { status: DriveCollectionStatus | null; busy: boolean; error: Failure | null; revision: number };
const initial = (): CollectionValue => ({ status: null, busy: false, error: null, revision: 0 });

/** Existing preparation operations, retained independently of their body. */
export function useDriveCollectionModel(backgroundEnabled: boolean | null, active = true) {
  const session = useDrivePacketSession("collection");
  const lease = useMemo(() => ({ live: false, lock: false, serial: 0, key: session.key, active, token: session.token, guard: session.guard }), [session.key, session.token, session.guard, active]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: CollectionValue } | null>(null);
  const value = stored?.lease === lease ? stored.value : initial();
  const current = useCallback(() => {
    if (!lease.live || !lease.token) throw new Error("inactive");
    lease.guard();
  }, [lease]);
  useLayoutEffect(() => { lease.live = active && !!lease.token; return () => { lease.live = false; lease.serial += 1; }; }, [active, lease]);
  const change = useCallback((update: (value: CollectionValue) => CollectionValue) => {
    try { current(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : initial()) }));
  }, [current, lease]);
  const read = useCallback(async () => {
    if (lease.lock || !lease.token) return;
    try { current(); } catch { return; }
    const attempt = ++lease.serial;
    const guard = () => { current(); if (attempt !== lease.serial) throw new Error("superseded"); };
    try {
      const status = await DrivePacketService.collection(lease.token, guard);
      guard(); change(value => ({ ...value, status, error: null, revision: value.revision + 1 }));
    } catch { try { guard(); change(value => ({ ...value, error: "read" })); } catch { /* Retired read. */ } }
  }, [change, current, lease]);
  useEffect(() => {
    if (!active || !lease.token) return;
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !lease.lock) void read(); }, 15000);
    return () => { clearInterval(timer); };
  }, [active, backgroundEnabled, lease, read]);
  const toggle = async () => {
    const status = value.status;
    if (!status || lease.lock || !lease.token || !status.enabled && backgroundEnabled !== true) return;
    try { current(); } catch { return; }
    const next = !status.enabled, attempt = ++lease.serial;
    const guard = () => { current(); if (attempt !== lease.serial) throw new Error("superseded"); };
    lease.lock = true; change(value => ({ ...value, busy: true, error: null }));
    try {
      const status = await DrivePacketService.setProcessing(lease.token, next, guard);
      guard(); change(value => ({ ...value, status, revision: value.revision + 1 }));
    } catch { try { guard(); change(value => ({ ...value, error: next ? "on" : "off" })); } catch { /* Retired write. */ } }
    finally {
      if (attempt === lease.serial) lease.lock = false;
      try { guard(); change(value => ({ ...value, busy: false })); } catch { /* Retired lease cannot unlock its replacement. */ }
    }
  };
  return { ...value, available: !!session.token, read, toggle, mutationPending: () => lease.lock,
    caption: caption(value.status, backgroundEnabled, value.busy, value.error),
    paused: backgroundEnabled === false || value.status?.state === "paused",
    canToggle: !!value.status && !value.busy && (value.status.enabled || backgroundEnabled === true),
  };
}
export type DriveCollectionModel = ReturnType<typeof useDriveCollectionModel>;

export function DriveCollectionPanel({ backgroundEnabled }: { backgroundEnabled: boolean | null }) {
  const model = useDriveCollectionModel(backgroundEnabled);
  return model.available ? <DriveCollectionView model={model} /> : null;
}

/** Pure body; a retained owner may inject the existing packet body. */
export function DriveCollectionView({ model, packets }: { model: DriveCollectionModel; packets?: ReactNode }) {
  const { status, busy, error, revision, paused } = model;
  return <section aria-label="Drive document preparation" className="space-y-3">
    <SettingsGroup density="compact">
      <SettingsRow title="Prepare packets" description={model.caption}
        trailing={status ? <Switch size="ios" aria-label="Prepare packets" checked={status.enabled}
          disabled={!model.canToggle} onCheckedChange={() => void model.toggle()} /> : null} />
      {status && <details className="px-4 pb-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">View details</summary>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">{(["discovered", "indexed", "pending", "failed"] as const).map(name => <div key={name}><dt className="text-xs capitalize text-muted-foreground">{name}</dt><dd className="font-medium tabular-nums">{status.counts[name].toLocaleString()}</dd></div>)}</dl>
        <p className="mt-3">{status.lastIndexedAt ? `Last indexed ${new Date(status.lastIndexedAt).toLocaleString()}` : "No files indexed yet."}{status.initialIndexingDurationMs !== null ? ` · Initial indexing ${duration(status.initialIndexingDurationMs)}` : status.initialStartedAt && status.state === "indexing" ? " · Initial indexing in progress" : ""}</p>
        <p>Discovery work: {duration(status.syncDurationMs)}. Last sync: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Not completed"}.</p>
        <p>Text extracted: {status.counts.extracted.toLocaleString()} files{status.initialExtractionDurationMs !== null ? ` · Initial extraction ${duration(status.initialExtractionDurationMs)}` : ""}. Indexed files have completed document understanding.</p>
        {paused && <p>Saved packets were last verified before preparation paused.</p>}
      </details>}
      {/* After a failed change the switch itself is how to try again. */}
      {error === "read" && <Button size="compact" variant="ghost" disabled={busy} onClick={() => void model.read()}>Retry preparation</Button>}
    </SettingsGroup>
    {status && (packets !== undefined ? packets : <DrivePacketCatalog refreshKey={revision} preparationPaused={paused || !status.enabled} />)}
  </section>;
}
