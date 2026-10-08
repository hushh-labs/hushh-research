import { buildPkmSectionPreviewPresentation, type PkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";
import { decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { isPacketDeliveryPayload } from "@/lib/one-marketplace/packet-delivery";
import { OneMarketplaceService, type MarketplaceRequest } from "@/lib/one-marketplace/service";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

function parseDeliveryScope(
  scope: string,
  fallbackDomain: string,
): { domain: string; topLevelScopePath: string } {
  const match = /^attr\.([a-zA-Z0-9_]+)(?:\.(.+))?$/.exec(String(scope || "").trim());
  if (!match) return { domain: fallbackDomain, topLevelScopePath: "" };
  const remainder = (match[2] || "").replace(/\.\*$/, "").replace(/^\*$/, "").trim();
  return { domain: match[1] || fallbackDomain, topLevelScopePath: remainder };
}

/**
 * The decrypted payload is `{ [domain]: {…}, __export_metadata }` (see
 * export-builder + projectDomainDataForScope). Strip the metadata and return the
 * domain's record so the preview builder can project it like any other section.
 */
function extractDeliveredValue(
  decrypted: unknown,
  domain: string,
): Record<string, unknown> | null {
  if (!decrypted || typeof decrypted !== "object" || Array.isArray(decrypted)) return null;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decrypted as Record<string, unknown>)) {
    if (key === "__export_metadata") continue;
    rest[key] = value;
  }
  const domainValue = domain ? rest[domain] : undefined;
  if (domainValue && typeof domainValue === "object" && !Array.isArray(domainValue)) {
    return domainValue as Record<string, unknown>;
  }
  const keys = Object.keys(rest);
  if (keys.length === 1) {
    const only = rest[keys[0]!];
    if (only && typeof only === "object" && !Array.isArray(only)) {
      return only as Record<string, unknown>;
    }
  }
  return rest;
}

/** Build the safe-summary presentation for a decrypted delivered slice. */
function buildDeliveryPresentation(
  request: MarketplaceRequest,
  envelope: { metadata?: { scope?: string } },
  decrypted: unknown,
): PkmSectionPreviewPresentation {
  const scope = String(envelope.metadata?.scope ?? "");
  const { domain, topLevelScopePath } = parseDeliveryScope(scope, request.domain || "");
  const value = extractDeliveredValue(decrypted, domain);
  return buildPkmSectionPreviewPresentation({
    domain: domain || request.domain || "",
    domainTitle: request.domain || domain || "Information",
    permissionLabel: request.sliceName || "Delivered slice",
    permissionDescription: null,
    topLevelScopePath,
    value,
  });
}

type MarketplaceDeliveryParams = {
  request: MarketplaceRequest; userId: string; vaultKey: string | null; vaultOwnerToken: string;
};

type OpenedMarketplaceDelivery = {
  envelope: { metadata?: { scope?: string } };
  decrypted: unknown;
};

/** Both presentation shapes use the same paid export and vault authority. */
async function readMarketplaceDelivery(params: MarketplaceDeliveryParams): Promise<OpenedMarketplaceDelivery | null> {
  const { request, userId, vaultKey, vaultOwnerToken } = params;
  const epoch = snapshotVaultSessionEpoch();
  const assertCurrent = () => {
    if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Unlock your vault again before opening information.");
  };
  const { envelope, encryptedExport } = await OneMarketplaceService.getDelivery({ vaultOwnerToken, requestId: request.id });
  assertCurrent();
  if (encryptedExport) {
    if (!vaultKey || encryptedExport.export_envelope?.version !== 2) throw new Error("Unlock your vault to open this verified paid export.");
    const connector = await OneKycClientZkService.readStoredConnector({ userId, vaultKey, vaultOwnerToken });
    assertCurrent();
    if (!connector) throw new Error("This information requires the connector that requested it. Request access again.");
    const decrypted = await OneKycClientZkService.decryptScopedExport({ exportPackage: encryptedExport, connector });
    assertCurrent();
    return { envelope: { metadata: { scope: encryptedExport.export_envelope.aad.machine_scope } }, decrypted };
  }
  if (request.metadata?.commercial_required === true && envelope) throw new Error("Paid information requires a verified v2 export.");
  if (!envelope) return null;
  const decrypted = await decryptMarketplaceEnvelope({ userId, envelope });
  assertCurrent();
  return { envelope: { metadata: { scope: typeof envelope.metadata?.scope === "string" ? envelope.metadata.scope : undefined } }, decrypted };
}

/** Compatibility facade for existing single-slice callers. */
export async function openMarketplaceDelivery(params: MarketplaceDeliveryParams): Promise<PkmSectionPreviewPresentation | null> {
  const delivery = await readMarketplaceDelivery(params);
  return delivery ? buildDeliveryPresentation(params.request, delivery.envelope, delivery.decrypted) : null;
}

/** Preserve every packet part without bypassing paid v2 verification. */
export async function openMarketplaceDeliveryPresentations(params: MarketplaceDeliveryParams): Promise<{
  presentations: PkmSectionPreviewPresentation[];
  missing: string[];
} | null> {
  const delivery = await readMarketplaceDelivery(params);
  if (!delivery) return null;
  if (!isPacketDeliveryPayload(delivery.decrypted)) {
    if (delivery.decrypted && typeof delivery.decrypted === "object" &&
        (delivery.decrypted as { kind?: unknown }).kind === "pkm_packet") {
      throw new Error("This packet's delivered information is invalid. Request a new delivery.");
    }
    return { presentations: [buildDeliveryPresentation(params.request, delivery.envelope, delivery.decrypted)], missing: [] };
  }
  const packet = delivery.decrypted;
  if (!Array.isArray(packet.missing) ||
      packet.parts.some((part) => !part || typeof part.domain !== "string" || typeof part.scope !== "string" || typeof part.label !== "string") ||
      packet.missing.some((part) => !part || typeof part.label !== "string")) {
    throw new Error("This packet's delivered information is invalid. Request a new delivery.");
  }
  return {
    presentations: packet.parts.map((part) => {
      const { domain, topLevelScopePath } = parseDeliveryScope(part.scope, part.domain);
      return buildPkmSectionPreviewPresentation({
        domain: domain || part.domain,
        domainTitle: part.domain,
        permissionLabel: part.label,
        permissionDescription: null,
        topLevelScopePath,
        value: extractDeliveredValue(part.payload, domain),
      });
    }),
    missing: packet.missing.map((part) => part.label),
  };
}
