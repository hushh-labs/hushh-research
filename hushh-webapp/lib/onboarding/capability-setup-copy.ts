import {
  ONE_SETUP_CAPABILITIES,
  type OneCapability,
} from "@/lib/onboarding/one-capabilities";
import { buildOneSetupCapabilityRoute } from "@/lib/navigation/routes";

/**
 * SETUP COPY — One's voice, plain language, for the `/one/setup` hub and the
 * guided per-capability sub-flow.
 *
 * Rules (Phase 9):
 * - No system nouns leak to the person: no "vault", "token", "OAuth", "PKM",
 *   "decrypt". One speaks like a helpful person, not a settings panel.
 * - `setupTitle` is an action-framed heading ("Set up your finances"), distinct
 *   from the catalog `title` ("Finance") used as the short label.
 * - `setupBlurb` explains the *value* of finishing the step in one sentence.
 * - `href` ALWAYS points at the setup-scoped handoff route
 *   (`/one/setup/<id>`). That route is allow-listed through the hard setup
 *   gate, so a first-time tap is never bounced back to `/one/setup`;
 *   it resolves the gate and forwards to the canonical capability destination.
 */
export interface CapabilitySetupCopy {
  id: string;
  /** Short label, reused from the shared catalog. */
  title: string;
  /** Action-framed heading shown in the guided flow. */
  setupTitle: string;
  /** One-sentence, value-first explanation. */
  setupBlurb: string;
  /**
   * Where "Set up" / "Explore" routes for this capability. Always the
   * setup-scoped handoff route (`/one/setup/<id>`) so the hard setup gate
   * never bounces a first-time tap.
   */
  href: string;
  /**
   * First-visit Explore card copy for explore-only capabilities (those that
   * collect nothing). Present only for explore-only ids. `exploreTitle` is a
   * warm "here's what's in this tab" heading; `exploreBullets` are 2-3 plain
   * one-liners describing what the person can do here, no system nouns.
   */
  exploreTitle?: string;
  exploreBlurb?: string;
  exploreBullets?: readonly string[];
  /**
   * 2-3 plain one-liners describing what the person will do or get when they set
   * this capability up. Shown on the per-capability onboarding step for setup
   * (non-explore-only) capabilities. No system nouns.
   */
  setupBullets?: readonly string[];
}

const SETUP_COPY_BY_ID: Record<
  string,
  {
    setupTitle: string;
    setupBlurb: string;
    exploreTitle?: string;
    exploreBlurb?: string;
    exploreBullets?: readonly string[];
    setupBullets?: readonly string[];
  }
> = {
  finance: {
    setupTitle: "Set up your finances",
    setupBlurb:
      "Tell One how you like to invest so it can read your portfolio and surface analysis that fits you.",
    setupBullets: [
      "Share how you like to invest in a few quick taps.",
      "One reads your portfolio and tailors the analysis to you.",
      "Hand off to a real advisor whenever you want.",
    ],
  },
  gmail: {
    setupTitle: "Connect Gmail",
    setupBlurb:
      "Connect Gmail so One can keep a private memory of your purchases and pull up any receipt in seconds.",
    setupBullets: [
      "Connect Gmail once, with your approval.",
      "One keeps a private memory of your purchases.",
      "Pull up any receipt in seconds.",
    ],
  },
  email: {
    setupTitle: "Let One draft for you",
    setupBlurb:
      "Set up email so One can prepare replies and approvals you can send with a tap.",
    setupBullets: [
      "One drafts replies and approvals you can send with a tap.",
      "Everything stays a draft until you choose to send it.",
      "You are always in control of what goes out.",
    ],
  },
  location: {
    setupTitle: "Set up location",
    setupBlurb:
      "Share location when it helps so One can offer local context and referrals. You stay in control.",
    setupBullets: [
      "Share your location only when it actually helps.",
      "One adds local context and referrals around you.",
      "Turn sharing off whenever you want.",
    ],
  },
  ria: {
    setupTitle: "Set up RIA",
    setupBlurb:
      "Create and verify your advisor profile so One can open the right professional workspace for you.",
    setupBullets: [
      "Verify your advisor or firm credentials.",
      "Choose the services you offer and review your profile.",
      "Submit only when the profile is accurate.",
    ],
  },
  pkm: {
    setupTitle: "Save what matters",
    setupBlurb:
      "Keep notes and personal details in one private place that only you and One can open.",
    setupBullets: [
      "Save notes and personal details in one place.",
      "Only you and One can ever open it.",
      "One recalls what matters exactly when you need it.",
    ],
  },
  consent: {
    setupTitle: "Review who has access",
    setupBlurb:
      "See every request to use your personal information, approve what you trust, and pull access back any time.",
    exploreTitle: "Here's your access center",
    exploreBlurb:
      "Nothing to set up. This is where you see and control who can use your personal information.",
    exploreBullets: [
      "Every request to use your personal information shows up here.",
      "Approve what you trust, decline the rest.",
      "Pull access back at any time, instantly.",
    ],
  },
  "connected-systems": {
    setupTitle: "Link your tools",
    setupBlurb:
      "Review the CRM systems available to your account and choose where One should find or create your profile.",
    setupBullets: [
      "See every CRM system currently available to your account.",
      "Check whether your profile already exists before creating one.",
      "One creates or updates a profile only after your approval.",
    ],
  },
};

function toSetupCopy(cap: OneCapability): CapabilitySetupCopy {
  const extra = SETUP_COPY_BY_ID[cap.id];
  return {
    id: cap.id,
    title: cap.title,
    setupTitle: extra?.setupTitle ?? `Set up ${cap.title}`,
    setupBlurb: extra?.setupBlurb ?? cap.description,
    // Every tile routes through the onboarding-scoped handoff so the hard gate
    // never bounces a first-time tap. The handoff resolves the gate and
    // forwards to the canonical capability destination.
    href: buildOneSetupCapabilityRoute(cap.id),
    exploreTitle: extra?.exploreTitle,
    exploreBlurb: extra?.exploreBlurb,
    exploreBullets: extra?.exploreBullets,
    setupBullets: extra?.setupBullets,
  };
}

/** Ordered setup copy for the authored onboarding sequence only. */
export const CAPABILITY_SETUP_COPY: readonly CapabilitySetupCopy[] =
  ONE_SETUP_CAPABILITIES.map(toSetupCopy);

/** Lookup setup copy by capability id. */
export function getCapabilitySetupCopy(
  id: string,
): CapabilitySetupCopy | undefined {
  return CAPABILITY_SETUP_COPY.find((c) => c.id === id);
}
