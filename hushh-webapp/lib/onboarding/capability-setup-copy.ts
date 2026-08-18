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
  /** Short, capability-specific action for the setup-hub trailing label. */
  actionLabel: string;
  /** Short continuation action after the capability has started. */
  resumeActionLabel: string;
  /**
   * One short premise and one consent-safe promise for the optional cinematic
   * entry screen. This is presentation-only: it never changes setup state.
   */
  introPremise?: string;
  introPromise?: string;
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
    actionLabel: string;
    resumeActionLabel: string;
    introPremise?: string;
    introPromise?: string;
    exploreTitle?: string;
    exploreBlurb?: string;
    exploreBullets?: readonly string[];
    setupBullets?: readonly string[];
  }
> = {
  finance: {
    setupTitle: "Set up money",
    setupBlurb: "See how your money is doing.",
    actionLabel: "Set up",
    resumeActionLabel: "Finish",
    introPremise: "See your money clearly.",
    introPromise: "Only accounts you share.",
    setupBullets: [
      "Share how you like to invest.",
      "One tailors what it shows you.",
      "Hand off to an advisor anytime.",
    ],
  },
  gmail: {
    setupTitle: "Connect Gmail",
    setupBlurb: "One learns what you care about.",
    actionLabel: "Connect",
    resumeActionLabel: "Finish",
    introPremise: "Your mail, made useful.",
    introPromise: "Connected only with your approval.",
    setupBullets: [
      "Connect Gmail once with your approval.",
      "One learns the brands you care about.",
      "What it remembers stays private.",
    ],
  },
  calendar: {
    setupTitle: "Connect calendar",
    setupBlurb: "One keeps track of your day.",
    actionLabel: "Connect",
    resumeActionLabel: "Finish",
    introPremise: "Understand your schedule.",
    introPromise: "See what is ahead.",
    setupBullets: [
      "Connect Calendar with the access you choose.",
      "Ask One what is on today.",
      "Approve schedule changes first.",
    ],
  },
  email: {
    setupTitle: "Identity checks",
    setupBlurb: "One drafts replies. You approve.",
    actionLabel: "Set up",
    resumeActionLabel: "Finish",
    introPremise: "Replies, ready when you are.",
    introPromise: "You approve every reply.",
    setupBullets: [
      "Turn drafting on or off anytime.",
      "Review every draft before it sends.",
    ],
  },
  location: {
    setupTitle: "Set up location",
    setupBlurb: "Share where you are, when you want.",
    actionLabel: "Set up",
    resumeActionLabel: "Finish",
    introPremise: "Easier to reach when it matters.",
    introPromise: "Private until you share.",
    setupBullets: [
      "Choose who sees your location.",
      "Start and stop sharing anytime.",
      "Private by default.",
    ],
  },
  ria: {
    setupTitle: "Set up advisor profile",
    setupBlurb: "Verify once. Get your workspace.",
    actionLabel: "Verify",
    resumeActionLabel: "Finish",
    introPremise: "A workspace for your practice.",
    introPromise: "You review every detail.",
    setupBullets: [
      "Verify advisor credentials.",
      "Choose your services.",
      "Submit when ready.",
    ],
  },
  pkm: {
    setupTitle: "Save what matters",
    setupBlurb: "Notes only you can open.",
    actionLabel: "Save",
    resumeActionLabel: "Finish",
    setupBullets: [
      "Save details in one place.",
      "Only you can open them.",
      "One recalls them when needed.",
    ],
  },
  consent: {
    setupTitle: "Review access",
    setupBlurb: "Approve or revoke access anytime.",
    actionLabel: "Review",
    resumeActionLabel: "Review",
    exploreTitle: "Access center",
    exploreBlurb: "See and control who can use your data.",
    exploreBullets: [
      "Access requests appear here.",
      "Approve or decline instantly.",
      "Revoke access anytime.",
    ],
  },
  "connected-systems": {
    setupTitle: "Connect CRM",
    setupBlurb: "One finds your record. You approve.",
    actionLabel: "Connect",
    resumeActionLabel: "Finish",
    introPremise: "Start with your existing records.",
    introPromise: "Nothing changes without approval.",
    setupBullets: [
      "One finds or creates your record.",
      "Nothing happens without your approval.",
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
    actionLabel: extra?.actionLabel ?? `Set up ${cap.title}`,
    resumeActionLabel: extra?.resumeActionLabel ?? `Finish ${cap.title}`,
    introPremise: extra?.introPremise,
    introPromise: extra?.introPromise,
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
