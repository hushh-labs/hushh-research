import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock("@/lib/services/api-client", () => ({ apiJson }));
import { BusinessSuggestionService } from "@/lib/services/business-suggestion-service";

const empty = {
  contract_version: "b2b-profile-suggestion.v1", scope: "b2b",
  status: "no_match", candidates: [], pkm_written: false,
};

describe("business suggestion transport", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("admits real candidates only in v2 and preserves independent branch identities", async () => {
    const real = { business_uid: `urn:hushh:business:directory:hotel:${"a".repeat(64)}`, synthetic: false,
      source_identity: { source: "directory", source_key: '{"id":"1"}', vertical: "hotel" },
      match_evidence: [{ kind: "verified_phone" }], draft: { name: "Example branch", website: "", phone: "2025550123" },
      ownership_verified: false, claim_created: false, verification_required: ["business_authority"] };
    const response = { ...empty, contract_version: "b2b-profile-suggestion.v2", status: "suggestion_available", coverage_incomplete: true,
      candidates: [real, { ...real, business_uid: `urn:hushh:business:directory:hotel:${"b".repeat(64)}`,
        source_identity: { ...real.source_identity, source_key: '{"id":"2"}' } }] };
    apiJson.mockResolvedValue(response);
    const result = await BusinessSuggestionService.get("owner-token");
    expect(result.coverageIncomplete).toBe(true);
    expect(result.candidates.map(candidate => candidate.businessUid)).toHaveLength(2);
    expect(result.candidates.every(candidate => !candidate.synthetic && !candidate.ownershipVerified)).toBe(true);
    for (const invalid of [
      { ...response, contract_version: "b2b-profile-suggestion.v1" },
      { ...response, candidates: [real, real] },
      { ...response, candidates: [{ ...real, ownership_verified: true }] },
      { ...response, candidates: [{ ...real, source_identity: { ...real.source_identity, vertical: "ria" } }] },
    ]) {
      apiJson.mockResolvedValue(invalid);
      await expect(BusinessSuggestionService.get("owner-token")).rejects.toThrow();
    }
  });

  it("uses the existing platform transport without a client identity or persistence", async () => {
    apiJson.mockResolvedValue(empty);
    const controller = new AbortController();
    const result = await BusinessSuggestionService.get("owner-token", controller.signal);
    expect(apiJson).toHaveBeenCalledWith("/api/one/business/suggestion", {
      method: "GET", headers: { Authorization: "Bearer owner-token" },
      cache: "no-store", signal: controller.signal,
    });
    expect(result).toEqual({ contractVersion: "b2b-profile-suggestion.v1", scope: "b2b", status: "no_match", candidates: [], pkmWritten: false });
  });

  it("does not dispatch without owner authority", async () => {
    await expect(BusinessSuggestionService.get(" ")).rejects.toThrow("Unlock");
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("projects the labelled test candidate without turning it into ownership", async () => {
    apiJson.mockResolvedValue({ ...empty, status: "suggestion_available", candidates: [{
      business_uid: "urn:hushh:business:uat:hushh.ai:v1", synthetic: true,
      source_identity: { source: "uat_fixture", source_key: "hushh.ai:v1" },
      match_evidence: [{ kind: "verified_email_domain", domain: "hushh.ai" }],
      draft: { name: "Hushh — UAT Test Business", category: "Software company · Private intelligence",
        formatted_address: "100 UAT Test Avenue, Austin, TX 78701", phone: "+1 202-555-0147",
        website: "https://hushh.ai", hours: "Mon–Fri · 9:00 AM–5:00 PM (UAT fixture)",
        about: "Synthetic UAT business used to verify business-profile matching, review, and explicit save flows." },
      ownership_verified: false, claim_created: false,
      verification_required: ["business_authority"],
    }] });
    const result = await BusinessSuggestionService.get("owner-token");
    expect(result.candidates[0]).toMatchObject({
      businessUid: "urn:hushh:business:uat:hushh.ai:v1",
      synthetic: true, ownershipVerified: false, claimCreated: false,
      sourceIdentity: { source: "uat_fixture", sourceKey: "hushh.ai:v1" },
    });
  });

  it.each([
    { ...empty, pkm_written: true },
    { ...empty, status: "suggestion_available" },
    { ...empty, contract_version: "unknown" },
  ])("fails closed on an incompatible or contradictory response", async (payload) => {
    apiJson.mockResolvedValue(payload);
    await expect(BusinessSuggestionService.get("owner-token")).rejects.toThrow();
  });

  it("preserves unavailable as an error, not no-match", async () => {
    const failure = new Error("Unavailable");
    apiJson.mockRejectedValue(failure);
    await expect(BusinessSuggestionService.get("owner-token")).rejects.toBe(failure);
  });
});
