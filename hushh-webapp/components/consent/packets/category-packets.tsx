"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { DrivePacket, DrivePacketCategory } from "@/lib/services/drive-packet-service";
import { PACKET_CATEGORY_NAMES, categoryPeriods, packetCategories, buyerPacketStatus, ownerPeriodStatusLine, ownerPeriodTitle, periodLabel, packetPeriod, savedPacketRequest, type BuyerPacketRequest } from "./packet-copy";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";

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
    <SettingsRow title="All categories" ariaLabel="Back to all categories" onClick={close} chevron />
    {periods.map(packet => {
      const request = savedPacketRequest(packet) ?? requestFor(packet);
      return <SettingsRow key={packet.packetId} title={buyer ? periodLabel(packetPeriod(packet)) ?? packet.title : ownerPeriodTitle(packet)}
        description={buyer ? buyerPacketStatus(packet, request, "the owner").line : ownerPeriodStatusLine(packet)} textOverflow="wrap"
        trailing={buyer && packet.state === "ready" && packet.canRequest && !request ? formatDocumentRequestPrice(packet.priceCents) : undefined}
        onClick={() => onOpen(packet)} chevron />;
    })}
    {!periods.length && <SettingsRow title="No packets yet" />}
  </>;
}
