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
    setupTitle: "Set up your money",
    setupBlurb: "See how your money is doing.",
    actionLabel: "Set up Finance",
    resumeActionLabel: "Finish Finance",
    introPremise: "See your money clearly.",
    introPromise: "Only the accounts you share. Nothing else.",
    setupBullets: [
      "Tell One how you like to invest.",
      "One reads your portfolio and tailors what it shows you.",
      "Hand off to a real advisor any time.",
    ],
  },
  gmail: {
    setupTitle: "Connect Gmail",
    setupBlurb: "One learns what you care about.",
    actionLabel: "Connect Gmail",
    resumeActionLabel: "Finish Gmail",
    introPremise: "Your mail, made useful.",
    introPromise: "Connected only with your yes.",
    setupBullets: [
      "Connect Gmail once, with your yes.",
      "One learns the brands you care about.",
      "What it remembers stays private to you.",
    ],
  },
  calendar: {
    setupTitle: "Connect your calendar",
    setupBlurb: "One keeps track of your day.",
    actionLabel: "Connect Calendar",
    resumeActionLabel: "Finish Calendar",
    introPremise: "Understand your schedule.",
    introPromise: "See what's ahead, and make time for what matters.",
    setupBullets: [
      "Connect Google Calendar with the access you choose.",
      "Ask One what's on today.",
      "Approve every meeting change before it happens.",
    ],
  },
  email: {
    // "KYC" is an abbreviation nobody meets for the first time and understands.
    // The row now says what actually happens; the destination keeps the name.
    setupTitle: "Identity checks",
    setupBlurb: "One drafts the replies. You approve.",
    actionLabel: "Set up KYC",
    resumeActionLabel: "Finish KYC",
    introPremise: "Replies, ready when you are.",
    introPromise: "You approve every reply.",
    setupBullets: [
      "Turn drafting on or off any time.",
      "Every draft is yours to review before it sends.",
    ],
  },
  location: {
    setupTitle: "Set up location",
    setupBlurb: "Share where you are, when you want.",
    actionLabel: "Choose location",
    resumeActionLabel: "Finish location",
    introPremise: "Be easier to reach when it matters.",
    introPromise: "Private until you choose to share.",
    setupBullets: [
      "Pick the people who can see where you are.",
      "Start and stop sharing any time.",
      "Private unless you choose to share.",
    ],
  },
  ria: {
    setupTitle: "Set up your advisor profile",
    setupBlurb: "Verify once. Get your advisor workspace.",
    actionLabel: "Verify RIA",
    resumeActionLabel: "Finish RIA",
    introPremise: "A workspace built for your practice.",
    introPromise: "You review every detail first.",
    setupBullets: [
      "Verify your advisor or firm credentials.",
      "Choose the services you offer.",
      "Submit only when the profile is right.",
    ],
  },
  pkm: {
    setupTitle: "Save what matters",
    setupBlurb: "Notes only you can open.",
    actionLabel: "Save what matters",
    resumeActionLabel: "Finish saving",
    setupBullets: [
      "Save notes and details in one place.",
      "Only you and One can open it.",
      "One recalls them when you need them.",
    ],
  },
  consent: {
    setupTitle: "Review who has access",
    setupBlurb: "Approve or pull back access.",
    actionLabel: "Review access",
    resumeActionLabel: "Review access",
    exploreTitle: "Here's your access center",
    exploreBlurb: "Nothing to set up. See and control who can use your data.",
    exploreBullets: [
      "Every request to use your data shows up here.",
      "Approve what you trust, decline the rest.",
      "Pull access back any time, instantly.",
    ],
  },
  "connected-systems": {
    setupTitle: "Connect your CRM",
    setupBlurb: "One finds your record. You approve.",
    actionLabel: "Set up CRM",
    resumeActionLabel: "Finish CRM",
    introPremise: "Start with the record you already have.",
    introPromise: "Nothing changes without your yes.",
    setupBullets: [
      "One looks for your record first, then creates one if needed.",
      "Nothing happens without your yes.",
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
