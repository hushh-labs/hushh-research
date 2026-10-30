/**
 * PKM packet delivery: one sealed envelope carrying every detail in a packet.
 *
 * A bought packet arrives as a marketplace request with domain "pkm_packet" and
 * scope handle "packet:<id>". On approval the owner's device looks the packet
 * up, builds the same safe export used for single slices for each detail it
 * lists, and seals them together for the buyer. Contents are read at delivery
 * time, so the buyer gets the packet as the owner keeps it now. A detail with no
 * saved data is listed as missing rather than failing the whole delivery.
 */

export const PACKET_DOMAIN = "pkm_packet";
const PACKET_HANDLE_PREFIX = "packet:";

export interface PacketPart {
  domain: string;
  scope: string;
  label: string;
  payload: unknown;
}

export interface PacketDeliveryPayload {
  kind: "pkm_packet";
  title: string;
  deliveredAt: string;
  parts: PacketPart[];
  missing: { domain: string; label: string }[];
}

export function packetIdFromRequest(domain: string, scopeHandle: string): string | null {
  if (domain !== PACKET_DOMAIN || !scopeHandle.startsWith(PACKET_HANDLE_PREFIX)) return null;
  const id = scopeHandle.slice(PACKET_HANDLE_PREFIX.length).trim();
  return id || null;
}

export function isPacketDeliveryPayload(value: unknown): value is PacketDeliveryPayload {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "pkm_packet" &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

/** Thrown when a detail simply has no saved data; any other error aborts delivery. */
export class PacketPartNoDataError extends Error {}

export interface PacketDeliveryDeps {
  /** The owner's own packet: title and the PKM details it lists. */
  getPacket: (packetId: string) => Promise<{
    title: string;
    contents: { domain: string; scopeHandle: string; label: string }[];
  } | null>;
  /** Canonical export scope for one detail (resolveExportScope). */
  resolveScope: (domain: string, scopeHandle: string) => Promise<string | null>;
  /** The safe export for one scope; throws PacketPartNoDataError when empty. */
  buildExport: (scope: string) => Promise<unknown>;
  now?: () => Date;
}

export async function buildPacketDeliveryPayload(
  packetId: string,
  deps: PacketDeliveryDeps,
): Promise<PacketDeliveryPayload> {
  const packet = await deps.getPacket(packetId);
  if (!packet) throw new Error("This packet no longer exists, so it can't be delivered.");
  if (packet.contents.length === 0) throw new Error("This packet has nothing in it to deliver.");

  const parts: PacketPart[] = [];
  const missing: { domain: string; label: string }[] = [];
  for (const item of packet.contents) {
    const scope = await deps.resolveScope(item.domain, item.scopeHandle);
    if (!scope) {
      missing.push({ domain: item.domain, label: item.label });
      continue;
    }
    try {
      parts.push({ domain: item.domain, scope, label: item.label, payload: await deps.buildExport(scope) });
    } catch (error) {
      if (error instanceof PacketPartNoDataError) {
        missing.push({ domain: item.domain, label: item.label });
        continue;
      }
      throw error;
    }
  }
  if (parts.length === 0) throw new Error("There's no saved data in this packet to deliver yet.");
  return {
    kind: "pkm_packet",
    title: packet.title,
    deliveredAt: (deps.now ?? (() => new Date()))().toISOString(),
    parts,
    missing,
  };
}
