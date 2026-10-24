"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { DrivePacket, DrivePacketCategory } from "@/lib/services/drive-packet-service";
import { PACKET_CATEGORY_NAMES, categoryPeriods, packetCategories, buyerPacketStatus, ownerPacketStatus, periodLabel, packetPeriod, savedPacketRequest, type BuyerPacketRequest } from "./packet-copy";
import { PacketRows } from "./packet-rows";

/** Category navigation has no processing or purchase authority. */
export function CategoryPacketRows({ packets, buyer, defaults, onOpen, requestFor }: {
  packets: readonly DrivePacket[]; buyer: boolean; onOpen: (packet: DrivePacket) => void;
  defaults: boolean;
  requestFor: (packet: DrivePacket) => BuyerPacketRequest | null;
}) {
  const pathname = usePathname();
  const [selected, setSelected] = useState<DrivePacketCategory | null>(null);
  const close = () => setSelected(null);
  useBackLayer(pathname, selected ? 3 : 0, () => { close(); return true; });
  const categories = packetCategories(packets, defaults && !buyer);
  if (!selected) return <>{categories.map(category => <SettingsRow key={category} title={PACKET_CATEGORY_NAMES[category]}
    ariaLabel={`Open ${PACKET_CATEGORY_NAMES[category]}`} chevron onClick={() => setSelected(category)} />)}</>;
  const periods = categoryPeriods(packets, selected);
  return <>
    <SettingsRow title={PACKET_CATEGORY_NAMES[selected]} trailing={<Button variant="ghost" size="compact" onClick={close}>All categories</Button>} />
    <PacketRows items={periods.map(packet => {
      const request = savedPacketRequest(packet) ?? requestFor(packet);
      const status = buyer ? buyerPacketStatus(packet, request, "the owner") : ownerPacketStatus(packet);
      return { id: packet.packetId, title: periodLabel(packetPeriod(packet)) ?? packet.title,
        statusLine: "line" in status ? status.line : status.word, tone: status.tone,
        amountCents: packet.state === "ready" && (buyer ? packet.canRequest && !request : packet.canList || packet.listingEnabled) ? packet.priceCents : null,
        onOpen: () => onOpen(packet) };
    })} />
    {!periods.length && <SettingsRow title="No packets yet" />}
  </>;
}
