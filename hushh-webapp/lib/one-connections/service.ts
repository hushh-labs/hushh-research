import { apiJson } from "@/lib/services/api-client";

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${vaultOwnerToken}`,
    "Content-Type": "application/json",
  };
}

export interface TrustedSeedResult {
  seeded: number;
  existingCount: number;
  skippedSelf: number;
}

/**
 * Client for the generalized trusted-connections graph. Seeding only, for now.
 * Separate from OneLocationService (SOS) by design.
 */
export const OneConnectionsService = {
  async seedTrustedConnections(params: {
    vaultOwnerToken: string;
  }): Promise<TrustedSeedResult> {
    const response = await apiJson<{ result: TrustedSeedResult }>(
      "/api/one/connections/seed-trusted",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
    return response.result;
  },
};
