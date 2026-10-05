/**
 * Career Agent client.
 *
 * - parseResume: sends the owner's file to the One backend, which parses it in
 *   a sandbox and returns a structured draft. Nothing is stored server-side.
 * - listRoles / applyToRole: talk to careers.hushh.ai directly from the owner's
 *   device. Applying sends the owner's own hussh sign-in token, so careers can
 *   prove who is applying; it is only ever called after explicit confirmation.
 */

import { resolveAppEnvironment } from "@/lib/app-env";
import { normalizeResume, type Resume } from "@/lib/career/resume";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";

export interface CareerRole {
  slug: string;
  family: "vacancy" | "catalog";
  title: string;
  group: string;
  summary: string;
  url: string;
  cities: string[];
  remoteEligible?: boolean;
  payBand?: string;
}

export interface CareerApplicationResult {
  reference: string | null;
  statusLink: string | null;
  emailed: boolean;
}

export function careersOrigin(): string {
  return resolveAppEnvironment() === "production" ? "https://careers.hushh.ai" : "https://uat.careers.hushh.ai";
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; detail?: { message?: string } | string }
    | null;
  if (typeof body?.detail === "object" && body.detail?.message) return body.detail.message;
  return (typeof body?.error === "string" && body.error) || fallback;
}

export const CareerService = {
  async parseResume(file: File, vaultOwnerToken: string): Promise<{ resume: Resume; truncated: boolean }> {
    const form = new FormData();
    form.append("file", file);
    const res = await ApiService.apiFetch("/api/one/career/resume/parse", {
      method: "POST",
      headers: { Authorization: `Bearer ${vaultOwnerToken}` },
      body: form,
    });
    if (!res.ok) throw new Error(await errorMessage(res, "We couldn't read that resume."));
    const body = (await res.json()) as { resume?: unknown; truncated?: boolean };
    return { resume: normalizeResume(body.resume), truncated: Boolean(body.truncated) };
  },

  async listRoles(): Promise<CareerRole[]> {
    const res = await fetch(`${careersOrigin()}/api/careers/agent/roles`, { cache: "no-store" });
    if (!res.ok) throw new Error(await errorMessage(res, "Couldn't load open roles."));
    const body = (await res.json()) as { roles?: CareerRole[] };
    return Array.isArray(body.roles) ? body.roles : [];
  },

  async applyToRole(params: {
    role: Pick<CareerRole, "slug" | "family">;
    firstName: string;
    lastName: string;
    location: string;
    resumeText: string;
    links: { linkedin?: string; github?: string; portfolio?: string };
    consentReceiptId: string;
  }): Promise<CareerApplicationResult> {
    const idToken = await AuthService.getIdTokenWithRetry();
    if (!idToken) throw new Error("Sign in again to apply.");
    const res = await fetch(`${careersOrigin()}/api/careers/agent/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: params.role.slug,
        family: params.role.family,
        first_name: params.firstName,
        last_name: params.lastName,
        location: params.location,
        resume_text: params.resumeText,
        ...params.links,
        candidate_consent: true,
        consent_receipt_id: params.consentReceiptId,
      }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, "The application didn't go through."));
    const body = (await res.json()) as { reference?: string; statusLink?: string; emailed?: boolean };
    return { reference: body.reference ?? null, statusLink: body.statusLink ?? null, emailed: Boolean(body.emailed) };
  },
};
