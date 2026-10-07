import { z } from "zod";

import { apiJson } from "@/lib/services/api-client";

const fixtureCandidateSchema = z.object({
  business_uid: z.literal("urn:hushh:business:uat:hushh.ai:v1"),
  synthetic: z.literal(true),
  source_identity: z.object({
    source: z.literal("uat_fixture"),
    source_key: z.literal("hushh.ai:v1"),
  }),
  match_evidence: z.array(z.object({
    kind: z.literal("verified_email_domain"), domain: z.literal("hushh.ai"),
  })).length(1),
  draft: z.object({ name: z.string().min(1), website: z.literal("https://hushh.ai") }),
  ownership_verified: z.literal(false),
  claim_created: z.literal(false),
  verification_required: z.array(z.literal("business_authority")).length(1),
});
const directoryCandidateSchema = z.object({
  business_uid: z.string().regex(/^urn:hushh:business:directory:(hotel|healthcare|ria|insurance|business):[a-f0-9]{64}$/),
  synthetic: z.literal(false),
  source_identity: z.object({ source: z.literal("directory"), source_key: z.string().min(1).max(2048),
    vertical: z.enum(["hotel", "healthcare", "ria", "insurance", "business"]) }),
  match_evidence: z.array(z.union([
    z.object({ kind: z.literal("verified_email_domain"), domain: z.string().min(3).max(253) }),
    z.object({ kind: z.literal("verified_phone") }),
    z.object({ kind: z.literal("verified_email_identity"), email: z.string().email() }),
  ])).min(1).max(2),
  draft: z.object({ name: z.string().min(1).max(160), website: z.string().max(512),
    phone: z.string().max(512).optional(), formatted_address: z.string().max(512).optional(),
    address_line1: z.string().max(512).optional(), street1: z.string().max(512).optional(),
    city: z.string().max(512).optional(), zip: z.string().max(512).optional(),
    state: z.string().max(512).optional(), category: z.string().max(512).optional() }),
  ownership_verified: z.literal(false), claim_created: z.literal(false),
  verification_required: z.array(z.literal("business_authority")).length(1),
}).refine(value => value.business_uid.includes(`:directory:${value.source_identity.vertical}:`));
const candidateSchema = z.union([fixtureCandidateSchema, directoryCandidateSchema]);

const responseSchema = z.object({
  contract_version: z.enum(["b2b-profile-suggestion.v1", "b2b-profile-suggestion.v2"]),
  scope: z.literal("b2b"),
  status: z.enum(["disabled", "no_match", "suggestion_available", "insufficient_signals", "unavailable"]),
  candidates: z.array(candidateSchema).max(100),
  coverage_incomplete: z.boolean().optional(),
  pkm_written: z.literal(false),
}).refine(value => (value.status === "suggestion_available") === (value.candidates.length > 0)
  && new Set(value.candidates.map(candidate => candidate.business_uid)).size === value.candidates.length
  && value.candidates.every(candidate => candidate.synthetic === (value.contract_version === "b2b-profile-suggestion.v1")));

export type BusinessSuggestion = {
  contractVersion: "b2b-profile-suggestion.v1" | "b2b-profile-suggestion.v2";
  scope: "b2b";
  status: "disabled" | "no_match" | "suggestion_available" | "insufficient_signals" | "unavailable";
  coverageIncomplete?: boolean;
  candidates: Array<{
    businessUid: string;
    synthetic: boolean;
    sourceIdentity: { source: "uat_fixture" | "directory"; sourceKey: string;
      vertical?: "hotel" | "healthcare" | "ria" | "insurance" | "business" };
    matchEvidence: Array<{ kind: "verified_email_domain"; domain: string } | { kind: "verified_phone" } | { kind: "verified_email_identity"; email: string }>;
    draft: { name: string; website: string; phone?: string; formatted_address?: string;
      address_line1?: string; street1?: string; city?: string; zip?: string; state?: string; category?: string };
    ownershipVerified: false;
    claimCreated: false;
    verificationRequired: Array<"business_authority">;
  }>;
  pkmWritten: false;
};

export const BusinessSuggestionService = {
  /** Call after setup resolves and the vault unlocks; never persist the result. */
  async get(vaultOwnerToken: string, signal?: AbortSignal): Promise<BusinessSuggestion> {
    if (!vaultOwnerToken.trim()) throw new Error("Unlock your vault to continue.");
    const value = responseSchema.parse(await apiJson<unknown>("/api/one/business/suggestion", {
      method: "GET",
      headers: { Authorization: `Bearer ${vaultOwnerToken}` },
      cache: "no-store",
      signal,
    }));
    return {
      contractVersion: value.contract_version,
      scope: value.scope,
      status: value.status,
      pkmWritten: value.pkm_written,
      ...(value.coverage_incomplete === undefined ? {} : { coverageIncomplete: value.coverage_incomplete }),
      candidates: value.candidates.map((candidate) => ({
        businessUid: candidate.business_uid,
        synthetic: candidate.synthetic,
        sourceIdentity: { source: candidate.source_identity.source, sourceKey: candidate.source_identity.source_key,
          ...("vertical" in candidate.source_identity ? { vertical: candidate.source_identity.vertical } : {}) },
        matchEvidence: candidate.match_evidence,
        draft: candidate.draft,
        ownershipVerified: candidate.ownership_verified,
        claimCreated: candidate.claim_created,
        verificationRequired: candidate.verification_required,
      })),
    };
  },
};
