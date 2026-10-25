"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { Button } from "@/components/ui/button";
import type { DrivePacket, PacketGuard } from "@/lib/services/drive-packet-service";
import { FinancialPacketSummaryService, type PacketPublicSummary } from "@/lib/services/financial-packet-summary-service";

export const PACKET_PUBLIC_SUMMARY_NOTICE = "Publish this period’s Financial summary to signed-in people, including people you aren’t connected with. It shows the search period, match count and $5 request price. File names, contents and original links stay private. Each buyer still needs your approval. Publishing this summary does not list files for connections.";

/** Publication is separate from connection listing, purchase authority and background access. */
export function usePacketPublicSummary(packet: DrivePacket | null, token: string | null, guard: PacketGuard, onChanged: () => void) {
  const summary = packet?.kind === "provider_discovery" && packet.category === "financial" ? packet.publicSummary : undefined;
  const key = packet && summary ? `${packet.packetId}:${packet.version}:${summary.version}:${summary.revision}` : "";
  const lease = useMemo(() => ({ live: false, lock: false, key, token, guard }), [key, token, guard]);
  useLayoutEffect(() => { lease.live = true; return () => { lease.live = false; }; }, [lease]);
  const [stored, setStored] = useState<{ lease: typeof lease; acknowledged: boolean; busy: boolean; message: string } | null>(null);
  const value = stored?.lease === lease ? stored : { lease, acknowledged: false, busy: false, message: "" };
  const current = useCallback(() => { lease.guard(); if (!lease.live || lease.key !== key || lease.token !== token) throw new Error("session_changed"); }, [key, token, lease]);
  const update = (change: Partial<typeof value>) => setStored(previous => ({ ...(previous?.lease === lease ? previous : value), ...change }));
  const enabled = Boolean(summary?.enabled && packet && summary.version === packet.version);
  const write = async (next: boolean) => {
    if (!packet || !summary || !lease.token || lease.lock || next && !value.acknowledged) return;
    try { current(); } catch { return; }
    lease.lock = true; update({ busy: true, message: "" });
    try {
      const expected: PacketPublicSummary = { ...summary, version: next ? packet.version : summary.version };
      await FinancialPacketSummaryService.publish(lease.token, packet.packetId, expected, next, current);
      current(); update({ acknowledged: false, message: next ? "Public summary published." : "Public summary hidden." }); dispatchConsentStateChanged(); onChanged();
    } catch { try {
      current(); update({ message: "Couldn’t confirm publication. Refresh the packet before trying again." }); onChanged();
    } catch { /* Retired owner. */ } }
    finally { lease.lock = false; try { current(); update({ busy: false }); } catch { /* Retired owner. */ } }
  };
  return { visible: Boolean(summary), enabled, acknowledged: value.acknowledged, busy: value.busy, message: value.message,
    notice: PACKET_PUBLIC_SUMMARY_NOTICE, submit: () => write(!enabled), withdraw: () => write(false), canWithdraw: Boolean(summary && summary.revision > 0), mutationPending: () => lease.lock,
    acknowledge: (acknowledged: boolean) => { try { current(); if (!lease.lock) update({ acknowledged }); } catch { /* Retired owner. */ } } };
}
export type PacketPublicSummaryControlModel = ReturnType<typeof usePacketPublicSummary>;
export function PacketPublicSummaryControl({ model }: { model: PacketPublicSummaryControlModel }) {
  if (!model.visible) return null;
  return <div className="space-y-3 px-4 pb-3">
    <p className="text-sm text-muted-foreground">{model.notice}</p>
    {!model.enabled && <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={model.acknowledged} disabled={model.busy}
      onChange={event => model.acknowledge(event.target.checked)} />I agree to publish this summary.</label>}
    <Button data-consent-quiet-action="true" data-consent-role="compact-action" variant="outline" size="compact"
      disabled={model.busy || !model.enabled && !model.acknowledged} onClick={() => void model.submit()}>
      {model.busy ? "Saving…" : model.enabled ? "Hide public summary" : "Publish summary"}</Button>
    {!model.enabled && model.canWithdraw && <Button variant="ghost" size="compact" disabled={model.busy} onClick={() => void model.withdraw()}>Hide public summary</Button>}
    {model.message && <p role="status" className="text-sm">{model.message}</p>}
  </div>;
}
