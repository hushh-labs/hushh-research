"use client";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { reconcileLivingSources, type LivingSourceInput, type LivingSourceInventory } from "@/lib/pkm/living-source-records";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export const LIVING_SOURCE_DOMAIN = "one_living_sources";
export async function syncLivingSources(params: { userId: string; vaultKey: string; vaultOwnerToken: string; idToken: string }): Promise<void> {
  const epoch = snapshotVaultSessionEpoch();
  const inputs: LivingSourceInput[] = []; const successful: string[] = []; const unavailable: string[] = [];
  try {
    const identity = await AccountIdentityService.refreshIdentityForSession(params.userId, params.idToken, { force: false });
    if (!identity || identity.user_id !== params.userId) throw new Error("Identity unavailable");
    inputs.push({ kind: "profile", id: params.userId, createdAt: identity.created_at ?? null, updatedAt: identity.updated_at ?? identity.last_synced_at ?? null,
      value: { name: identity.display_name ?? null, photo: identity.photo_url ?? null, email: identity.email ?? null } });
    successful.push("profile");
  } catch { unavailable.push("profile"); }
  try {
    const entries = new Map<string, LivingSourceInput>();
    for (const surface of ["pending", "active", "previous"] as const) {
      for (const requestView of (surface === "pending" ? ["received", "sent"] : ["received"]) as ("received" | "sent")[]) {
        for (let page = 1; ; page += 1) {
          const response = await ConsentCenterService.listEntries({ idToken: params.idToken, userId: params.userId, surface, requestView, page, limit: 100, force: true });
          if (response.user_id !== params.userId) throw new Error("Owner mismatch");
          for (const entry of response.items) {
            // Presentation fields only: tokens, request payloads and provider metadata never enter memory.
            const expired = entry.expires_at && Number(new Date(entry.expires_at)) < Date.now();
            entries.set(entry.id, { kind: "consent", id: entry.id,
              createdAt: entry.issued_at ? new Date(entry.issued_at).toISOString() : null,
              updatedAt: null, value: { scope: entry.scope ?? null, status: expired && entry.active ? "expired" : entry.status, active: expired ? false : entry.active === true,
                counterpart: entry.counterpart_id ?? null, expiresAt: entry.expires_at ?? null, action: entry.action } });
          }
          if (!response.has_more) break;
          if (!response.items.length) throw new Error("Incomplete source pagination");
        }
      }
    }
    inputs.push(...entries.values()); successful.push("consent");
  } catch { unavailable.push("consent"); }
  if (!isVaultSessionEpochCurrent(epoch)) return;
  const result = await PkmWriteCoordinator.saveMergedDomain({ ...params, domain: LIVING_SOURCE_DOMAIN,
    confirmation: { authorizationMode: "owner_source_projection", surface: "web", source: "one_living_memory_source_projection" },
    beforeEffect: async () => { if (!isVaultSessionEpochCurrent(epoch)) throw new Error("Vault session changed"); },
    build: (context) => {
      const current = context.currentDomainData ?? {};
      const privateData = (current._private ?? {}) as Record<string, unknown>;
      const previous = privateData.inventory as LivingSourceInventory | undefined;
      const inventory = reconcileLivingSources(previous ?? null, inputs, successful, unavailable, new Date().toISOString());
      return { domainData: { ...current, _private: { ...privateData, inventory } }, summary: { item_count: inventory.records.length, source_projection_complete: inventory.complete } };
    },
  });
  if (!result.success) throw new Error("Encrypted source projection not stored");
}
