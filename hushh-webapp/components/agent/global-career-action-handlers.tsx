"use client";

/**
 * hussh careers, from Agent One chat.
 *
 * There is no Career agent on the roster. When someone asks Agent One about
 * jobs at hussh, it lists the open roles from careers.hushh.ai and, after the
 * owner taps the confirmation card, applies with the resume saved in their
 * PKM. Mounted app-wide (like global-consent-action-handlers) because chat is
 * not the Career page, and requireMountedLocalHandlers drops any handler that
 * is not mounted.
 *
 * Safety properties:
 * - careers.apply re-resolves the role from the live careers list by the exact
 *   slug and family. A slug the portal does not list is refused, so the model
 *   cannot apply to something it invented or read out of role text.
 * - Nothing is sent without a saved resume; the owner is pointed to the
 *   Career page to add one rather than having chat guess their details.
 * - The backend hides both actions when ONE_CAREER_ENABLED is off, and lists
 *   careers.apply as tap-only (HARD_CARD_CONFIRMATION_ACTION_IDS).
 */

import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { applyWithSavedResume } from "@/lib/career/apply";
import { isEmptyResume } from "@/lib/career/resume";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { CareerPkmService } from "@/lib/services/career-pkm-service";
import { CareerService, type CareerRole } from "@/lib/services/career-service";
import { useVault } from "@/lib/vault/vault-context";

const MAX_ROLES = 10;

function matches(role: CareerRole, slots: Record<string, unknown> | null | undefined): boolean {
  const query = String(slots?.query || "").trim().toLowerCase();
  const city = String(slots?.city || "").trim().toLowerCase();
  const remoteOnly = slots?.remote === true || String(slots?.remote || "").toLowerCase() === "true";
  if (remoteOnly && !role.remoteEligible) return false;
  if (city && !role.cities.some((c) => c.toLowerCase().includes(city))) return false;
  if (!query) return true;
  const haystack = `${role.title} ${role.group} ${role.summary}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

export function GlobalCareerActionHandlers() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();

  useLocalOnboardingActionHandler(
    "careers.list_roles",
    async (slots) => {
      let roles: CareerRole[];
      try {
        roles = await CareerService.listRoles();
      } catch {
        return { status: "failed" as const, summary: "I couldn't reach the hussh careers portal. Try again in a moment." };
      }
      const found = roles.filter((role) => matches(role, slots));
      if (!found.length) {
        return {
          status: "succeeded" as const,
          summary: roles.length
            ? "No open hussh roles match that. Ask me to show all of them."
            : "hussh has no open roles right now.",
          data: { roles: [], total: roles.length },
        };
      }
      return {
        status: "succeeded" as const,
        summary: `${found.length} open hussh role${found.length === 1 ? "" : "s"}.`,
        data: {
          total: found.length,
          roles: found.slice(0, MAX_ROLES).map((role) => ({
            slug: role.slug,
            family: role.family,
            title: role.title,
            group: role.group,
            summary: role.summary,
            cities: role.cities,
            remoteEligible: Boolean(role.remoteEligible),
            url: role.url,
          })),
        },
      };
    },
    { enabled: Boolean(user) },
  );

  useLocalOnboardingActionHandler(
    "careers.apply",
    async (slots) => {
      const slug = String(slots?.slug || "").trim().toLowerCase();
      const family = slots?.family === "catalog" ? "catalog" : "vacancy";
      if (!slug) {
        return { status: "failed" as const, summary: "Tell me which role, and I'll apply." };
      }
      if (!user?.uid) return { status: "failed" as const, summary: "Sign in first." };
      if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
        return { status: "failed" as const, summary: "Unlock your private agent first, then ask me again." };
      }
      const write = { userId: user.uid, vaultKey, vaultOwnerToken };

      let role: CareerRole | undefined;
      try {
        role = (await CareerService.listRoles()).find((r) => r.slug === slug && r.family === family);
      } catch {
        return { status: "failed" as const, summary: "I couldn't reach the hussh careers portal. Nothing was sent." };
      }
      if (!role) {
        return { status: "failed" as const, summary: "That role isn't open on the hussh careers portal. Nothing was sent." };
      }

      const { resume } = await CareerPkmService.load(write);
      if (!resume || isEmptyResume(resume)) {
        return {
          status: "blocked" as const,
          summary: `Add your resume on the Career page (${ROUTES.ONE_CAREER}) first. Nothing was sent.`,
        };
      }

      try {
        const { result, receiptSaved } = await applyWithSavedResume({ role, resume, write });
        const summary = `Applied to ${role.title}${result.reference ? `. Reference ${result.reference}` : ""}.`;
        toast.success(summary);
        return {
          status: "succeeded" as const,
          summary: receiptSaved ? summary : `${summary} The receipt couldn't be saved to your memory.`,
          data: { reference: result.reference, statusLink: result.statusLink, roleTitle: role.title },
        };
      } catch (error) {
        // Never report success for an application that did not go through.
        return {
          status: "failed" as const,
          summary: error instanceof Error && error.message ? error.message : "The application didn't go through.",
        };
      }
    },
    // Not registered while signed out or locked, so the action drops out of
    // available_action_ids rather than being offered and then refused.
    { enabled: Boolean(user && isVaultUnlocked) },
  );

  return null;
}
