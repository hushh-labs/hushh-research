// The fixture replaces the encrypted storage boundary. Task transitions run in the real service.
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import type { PkmWriteCoordinator as ProductionCoordinator } from "@/lib/services/pkm-write-coordinator";
import { initialFollowupTasks } from "./mail-followups-boundaries";

let stored: Record<string, unknown> = { _private: { tasks: initialFollowupTasks() } };
export const PersonalKnowledgeModelService = {
  loadDomainData: async () => structuredClone(stored),
};

export const PkmWriteCoordinator = {
  async saveMergedDomain(write: Parameters<typeof ProductionCoordinator.saveMergedDomain>[0]) {
    const plan = await write.build({
      currentDomainData: structuredClone(stored), currentManifest: null, currentEncryptedDomain: null,
      baseFullBlob: {}, attempt: 0, upgradedInSession: false,
    });
    await write.beforeEffect?.();
    if (plan.unchanged) return { success: true, saveState: "saved", idempotentReplay: true, fullBlob: {} };
    stored = plan.domainData;
    if (document.documentElement.dataset.journey === "reminders") {
      document.documentElement.dataset.savedTasks = JSON.stringify(stored._private);
    }
    dispatchLocalPkmDomainChanged({ userId: write.userId, domain: write.domain,
      dataVersion: null, updatedAt: null, operation: "stored" });
    return { success: true, saveState: "saved", fullBlob: {} };
  },
};
