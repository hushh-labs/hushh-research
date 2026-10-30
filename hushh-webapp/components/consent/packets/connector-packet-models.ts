"use client";

import { useDrivePacketCatalogModel, useOwnerPacketPageModel } from "@/components/consent/drive-packet-catalog";
import { usePacketPublications } from "./packet-publications";

type Options = NonNullable<Parameters<typeof useDrivePacketCatalogModel>[0]> & { ownerActive: boolean };
/** One set of packet controllers outlives web/native renderers; publication recovery needs no Drive connection. */
export function useConnectorPacketModels({ ownerActive, ...options }: Options) {
  const packets = useDrivePacketCatalogModel(options);
  const packet = useOwnerPacketPageModel({ packet: ownerActive && packets.opened ? packets.live ?? (packets.cursor ? packets.opened : null) : null,
    token: packets.session.token, guard: packets.session.guard, onChanged: () => { void packets.load(); },
    onPreview: packets.preview, onMorePreview: packets.morePreview, previewBusy: packets.previewBusy, previewError: packets.previewError });
  const publications = usePacketPublications(ownerActive);
  return { packets, packet, publications };
}
