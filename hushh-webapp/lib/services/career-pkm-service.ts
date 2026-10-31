"use client";

/**
 * The Career Agent's part of the owner's PKM: the `professional` domain gains
 * `resume` (the structured resume) and `applications` (a receipt per
 * application the owner chose to send). Everything else already in the domain
 * is kept as-is. Encrypted on the owner's device with their vault key.
 */

import { normalizeResume, type Resume } from "@/lib/career/resume";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator, type PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";

export const CAREER_PKM_DOMAIN = "professional" as const;

export interface CareerApplicationReceipt {
  receipt_id: string;
  role_slug: string;
  role_title: string;
  sent_at: string;
  reference: string | null;
  status_link: string | null;
  /** Exactly what was sent, so the owner can always see what they shared. */
  shared: { name: string; location: string; resume_chars: number };
}

export interface CareerPkmState {
  resume: Resume | null;
  applications: CareerApplicationReceipt[];
}

function readApplications(value: unknown): CareerApplicationReceipt[] {
  return Array.isArray(value)
    ? value.filter(
        (x): x is CareerApplicationReceipt =>
          !!x && typeof x === "object" && typeof (x as CareerApplicationReceipt).receipt_id === "string",
      )
    : [];
}

export function readCareerState(domainData: Record<string, unknown> | null): CareerPkmState {
  const resume = domainData?.resume ? normalizeResume(domainData.resume) : null;
  return { resume, applications: readApplications(domainData?.applications) };
}

type WriteParams = { userId: string; vaultKey: string; vaultOwnerToken: string };

async function write(
  params: WriteParams,
  source: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<PkmWriteCoordinatorResult> {
  return PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: CAREER_PKM_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: { confirmedByUser: true, surface: "web", source },
    build: (context) => {
      const current = (context.currentDomainData ?? {}) as Record<string, unknown>;
      const domainData = update(current);
      const state = readCareerState(domainData);
      return {
        domainData,
        summary: {
          has_resume: Boolean(state.resume),
          role_count: state.resume?.experience.length ?? 0,
          skill_count: state.resume?.skills.length ?? 0,
          application_count: state.applications.length,
          last_updated: new Date().toISOString(),
        },
      };
    },
  });
}

export const CareerPkmService = {
  async load(params: WriteParams): Promise<CareerPkmState> {
    const data = await PersonalKnowledgeModelService.loadDomainData({
      userId: params.userId,
      domain: CAREER_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    return readCareerState(data);
  },

  saveResume(params: WriteParams & { resume: Resume }) {
    return write(params, "career_resume_owner_review", (current) => ({
      ...current,
      resume: { ...normalizeResume(params.resume), updated_at: new Date().toISOString(), schema_version: 1 },
    }));
  },

  recordApplication(params: WriteParams & { receipt: CareerApplicationReceipt }) {
    return write(params, "career_application_owner_confirmed", (current) => ({
      ...current,
      applications: [params.receipt, ...readApplications(current.applications)].slice(0, 200),
    }));
  },
};
