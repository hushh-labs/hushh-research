/** Synthetic service ports only. The machine, hook, writer, coordinator,
 * domain resource, display-name hook and AES implementation remain production. */
import { decryptData, encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import type { PersonalKnowledgeModelService as ProductionService } from "@/lib/services/personal-knowledge-model-service";

const userId = "synthetic-owner";
const vaultKey = "ab".repeat(32);
export const useAuth = () => ({ user: { uid: userId }, userId });
export const useVault = () => ({ isVaultUnlocked: true, vaultKey, vaultOwnerToken: "synthetic-owner-token" });
export const useLiveMirrorView = () => ({ status: "locked" as const });
export const PreVaultUserStateService = {
  bootstrapState: async () => ({ oneChatOnboarding: null }),
  syncOneChatOnboarding: async () => ({}),
};
export class ApiService {
  static apiFetch(path: string, options?: RequestInit) {
    return globalThis.fetch(path, options);
  }
}
export class PkmUpgradeOrchestrator {
  static ensureRunning = async () => { throw new Error("Unexpected upgrade in name fixture"); };
}
export class PkmUpgradeService {}

async function readIdentity() {
  const response = await ApiService.apiFetch("/__fixture/identity");
  if (!response.ok) throw new Error("Synthetic read failure");
  const payload = await response.json() as { encrypted: EncryptedPayload | null; revision: number };
  const data = payload.encrypted
    ? JSON.parse(await decryptData(payload.encrypted, vaultKey)) as Record<string, unknown>
    : { communication_preferences: { tone: "warm" } };
  return { data, blob: { dataVersion: payload.revision, updatedAt: null } };
}

export class PersonalKnowledgeModelService {
  static getMetadata = async () => null;
  static getDomainManifest = async () => null;
  static peekCachedDomainBlob = () => null;
  static loadDomainDataWithBlob = readIdentity;
  static loadDomainSnapshot = async () => ({ data: (await readIdentity()).data, snapshot: null });
  static async storeMergedDomainWithPreparedBlob(params: Parameters<typeof ProductionService.storeMergedDomainWithPreparedBlob>[0]) {
    await params.beforeEffect?.();
    const encrypted = await encryptData(JSON.stringify(params.domainData), params.vaultKey);
    await params.beforeEffect?.();
    const response = await ApiService.apiFetch("/__fixture/identity", { method: "PUT", body: JSON.stringify({ encrypted }) });
    if (!response.ok) return { success: false, conflict: false, fullBlob: {} };
    const { revision } = await response.json() as { revision: number };
    dispatchLocalPkmDomainChanged({ userId, domain: "identity", dataVersion: revision, updatedAt: null, operation: "stored" });
    return { success: true, dataVersion: revision, fullBlob: { identity: params.domainData } };
  }
}
