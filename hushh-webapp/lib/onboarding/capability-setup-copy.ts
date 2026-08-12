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
    setupTitle: "Set up your finances",
    setupBlurb:
      "Get analysis that fits how you invest.",
    actionLabel: "Set up Finance",
    resumeActionLabel: "Finish Finance",
    introPremise: "A clearer way to understand your money.",
    introPromise:
      "One only uses the accounts and preferences you choose to share.",
    setupBullets: [
      "Share how you invest in a few taps.",
      "One reads your portfolio and tailors the analysis to you.",
      "Hand off to a real advisor whenever you want.",
    ],
  },
  gmail: {
    setupTitle: "Connect Gmail",
    setupBlurb:
      "Connect Gmail so One can understand the brands you care about and build a private memory of recent interactions.",
    actionLabel: "Connect Gmail",
    resumeActionLabel: "Finish Gmail",
    introPremise: "Let the details you choose become more useful.",
    introPromise:
      "Gmail is connected only with your approval, and you stay in control of what One remembers.",
    setupBullets: [
      "Connect Gmail once, with your approval.",
      "One learns your brand affinities from the interactions you approve.",
      "Keep a private memory of recent interactions, ready when you need it.",
    ],
  },
  calendar: {
    setupTitle: "Connect your calendar",
    setupBlurb:
      "Connect Google Calendar so One can summarize your schedule, find time, and prepare meeting changes for your approval.",
    actionLabel: "Connect Calendar",
    resumeActionLabel: "Finish Calendar",
    introPremise: "Understand your schedule.",
    introPromise:
      "A clear view of what is ahead, with time for what matters.",
    setupBullets: [
      "Connect Google Calendar with the access you choose.",
      "Ask One for schedule summaries and availability.",
      "Review every meeting change before it happens.",
    ],
  },
  email: {
    setupTitle: "KYC",
    setupBlurb:
      "Choose whether requests you send to one@hushh.ai may prepare responses for your approval.",
    actionLabel: "Set up KYC",
    resumeActionLabel: "Finish KYC",
    introPremise: "An identity that moves at your pace.",
    introPromise:
      "You decide which details to save and when One may use them to help you.",
    setupBullets: [
      "Turn drafting on or off any time.",
      "Nothing sends until you approve it.",
    ],
  },
  location: {
    setupTitle: "Set up location",
    setupBlurb:
      "Share your location with the trusted people you choose.",
    actionLabel: "Choose location",
    resumeActionLabel: "Finish location",
    introPremise: "Be easier to reach when it matters.",
    introPromise:
      "Your location stays private until you choose the people and moment to share it.",
    setupBullets: [
      "Choose who can receive your location.",
      "Start and stop sharing any time.",
      "Your location stays private unless you choose to share it.",
    ],
  },
  ria: {
    setupTitle: "Set up RIA",
    setupBlurb:
      "Create and verify your advisor profile to open your workspace.",
    actionLabel: "Verify RIA",
    resumeActionLabel: "Finish RIA",
    introPremise: "A professional workspace shaped around your practice.",
    introPromise:
      "You review every detail before it becomes part of your advisor profile.",
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
    actionLabel: "Save what matters",
    resumeActionLabel: "Finish saving",
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
    actionLabel: "Review access",
    resumeActionLabel: "Review access",
    exploreTitle: "Here's your access center",
    exploreBlurb:
      "See and control who can use your personal information.",
    exploreBullets: [
      "Every request to use your personal information shows up here.",
      "Approve what you trust, decline the rest.",
      "Pull access back at any time, instantly.",
    ],
  },
  "connected-systems": {
    setupTitle: "CRM",
    setupBlurb:
      "Find your CRM record or approve creating one from your verified identity.",
    actionLabel: "Set up CRM",
    resumeActionLabel: "Finish CRM",
    introPremise: "Start with the record that already knows you.",
    introPromise:
      "One looks for your record before creating anything, and you approve every change.",
    setupBullets: [
      "One looks for your record first, then creates one if needed.",
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
