import type { InformationRequestBundle } from "@/lib/services/person-profile-service";
import type { KycScopedExportPackage } from "@/lib/services/one-kyc-client-zk-service";

type BundleItem = InformationRequestBundle["items"][number];

/** A restored Chat descriptor is never authority to open an export. */
export function isCurrentPersonExport(input: {
  item: BundleItem;
  scopeRef: string;
  exportPackage: KycScopedExportPackage;
  nowMs: number;
}): boolean {
  const { item, scopeRef, exportPackage, nowMs } = input;
  const envelope = exportPackage.export_envelope;
  const aad = envelope?.aad;
  return Boolean(
    item.status === "granted"
    && item.scopeRef === scopeRef
    && exportPackage.request_id === item.requestId
    && typeof exportPackage.scope === "string"
    && exportPackage.scope.length > 0
    && typeof exportPackage.export_revision === "number"
    && exportPackage.export_revision > 0
    && envelope?.version === 2
    && aad?.version === 2
    && aad.app_id === "agent_one"
    && aad.grant_id === item.requestId
    && aad.machine_scope === exportPackage.scope
    && aad.export_id === envelope.export_id
    && aad.revision === exportPackage.export_revision
    && aad.expires_at_ms > nowMs
    && aad.payload_algorithm === "AES-256-GCM"
  );
}
