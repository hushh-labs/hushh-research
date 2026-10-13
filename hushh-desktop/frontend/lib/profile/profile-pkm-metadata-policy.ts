import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";

export async function loadProfilePkmMetadataForVaultState({
  userId,
  hasVault,
  force = false,
  vaultOwnerToken,
}: {
  userId: string;
  hasVault: boolean;
  force?: boolean;
  vaultOwnerToken?: string | null;
}): Promise<PersonalKnowledgeModelMetadata> {
  if (!hasVault) {
    return PersonalKnowledgeModelService.emptyMetadata(userId);
  }

  return PersonalKnowledgeModelService.getMetadata(
    userId,
    force,
    vaultOwnerToken ?? undefined,
  );
}
