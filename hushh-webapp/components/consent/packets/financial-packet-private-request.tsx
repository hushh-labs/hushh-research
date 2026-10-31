"use client";

import { useEffect, useState } from "react";
import { DrivePacketService, type DrivePacket } from "@/lib/services/drive-packet-service";
import { DrivePacketResourceService } from "@/lib/services/drive-packet-resource-service";
import type { FinancialPacketSummary } from "@/lib/services/financial-packet-summary-service";
import { useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import { BuyerPacketPage, useBuyerPacketRequests } from "./buyer-packets";
import { PacketPage } from "./packet-page";

/** Resolve private purchase authority afresh; a public summary is never purchase authority. */
export function FinancialPacketPrivateRequest({ summary, personRef, ownerName, onClose, onChanged }: {
  summary: FinancialPacketSummary; personRef: string; ownerName: string; onClose: () => void; onChanged: () => void;
}) {
  const { token, guard: sessionGuard, key: sessionKey } = useDrivePacketSession(personRef);
  const [attempt, retry] = useState(0);
  const [value, setValue] = useState<{ key: string; packet: DrivePacket | null; failed: boolean } | null>(null);
  const requests = useBuyerPacketRequests();
  const key = `${sessionKey}:${summary.packetId}:${summary.version}:${attempt}`;
  useEffect(() => {
    let live = true;
    const guard = () => { sessionGuard(); if (!live) throw new Error("closed"); };
    if (!token) return;
    void (async () => {
      try {
        const packet = await DrivePacketResourceService.load(sessionKey, `financial-request:${summary.packetId}:${summary.version}`, guard, async current => {
          const seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const result = await DrivePacketService.packets(token!, current, personRef, cursor);
            current();
            const packet = result.packets.find(item => item.packetId === summary.packetId && item.version === summary.version);
            if (packet) return packet;
            cursor = result.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error("invalid_cursor");
            if (cursor) seen.add(cursor);
          } while (cursor && seen.size < 100);
          throw new Error("packet_unavailable");
        }, { force: true });
        guard(); setValue({ key, packet, failed: false });
      } catch { try { guard(); setValue({ key, packet: null, failed: true }); } catch { /* Retired session. */ } }
    })();
    return () => { live = false; };
  }, [key, personRef, sessionGuard, sessionKey, token, summary.packetId, summary.version]);
  const current = value?.key === key ? value : null;
  if (token && current?.packet) return <BuyerPacketPage key={key} packet={current.packet} ownerName={ownerName} token={token}
    guard={sessionGuard} requests={requests} onClose={onClose} onChanged={() => { retry(value => value + 1); onChanged(); }} />;
  return <PacketPage open onOpenChange={open => { if (!open) onClose(); }} title="Financial documents" sections={[]}
    description={current?.failed ? "This packet couldn’t be opened. Its availability may have changed." : "Checking your packet request…"}
    actions={current?.failed ? [{ id: "retry", label: "Retry", onSelect: () => retry(value => value + 1) }] : []} />;
}
