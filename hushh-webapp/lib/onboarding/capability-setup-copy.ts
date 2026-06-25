import { ONE_CAPABILITIES, type OneCapability } from "@/lib/onboarding/one-capabilities";
import { buildOneOnboardingRoute } from "@/lib/navigation/routes";

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
 * - `href` defers to the canonical capability route, except where a dedicated
 *   guided flow already exists (finance → the existing Kai onboarding wizard,
 *   which we must reuse rather than rebuild).
 */
export interface CapabilitySetupCopy {
  id: string;
  /** Short label, reused from the shared catalog. */
  title: string;
  /** Action-framed heading shown in the guided flow. */
  setupTitle: string;
  /** One-sentence, value-first explanation. */
  setupBlurb: string;
  /** Where "Set up" / "Continue" routes for this capability. */
  href: string;
}

const SETUP_COPY_BY_ID: Record<string, { setupTitle: string; setupBlurb: string; href?: string }> = {
  finance: {
    setupTitle: "Set up your finances",
    setupBlurb:
      "Tell One how you like to invest so it can read your portfolio and surface analysis that fits you.",
    // Reuse the existing finance onboarding wizard — do not rebuild it.
    href: buildOneOnboardingRoute(),
  },
  gmail: {
    setupTitle: "Bring in your receipts",
    setupBlurb:
      "Connect Gmail so One can keep a private memory of your purchases and pull up any receipt in seconds.",
  },
  email: {
    setupTitle: "Let One draft for you",
    setupBlurb:
      "Set up email so One can prepare replies and approvals you can send with a tap.",
  },
  location: {
    setupTitle: "Add live location",
    setupBlurb:
      "Share location when it helps so One can offer local context and referrals — you stay in control.",
  },
  pkm: {
    setupTitle: "Save what matters",
    setupBlurb:
      "Keep notes and personal details in one private place that only you and One can open.",
  },
  consent: {
    setupTitle: "Review who has access",
    setupBlurb:
      "See every request to use your data, approve what you trust, and pull access back any time.",
  },
  "connected-systems": {
    setupTitle: "Link your tools",
    setupBlurb:
      "Connect the systems you already use so One can read and update them with your approval.",
  },
};

function toSetupCopy(cap: OneCapability): CapabilitySetupCopy {
  const extra = SETUP_COPY_BY_ID[cap.id];
  return {
    id: cap.id,
    title: cap.title,
    setupTitle: extra?.setupTitle ?? `Set up ${cap.title}`,
    setupBlurb: extra?.setupBlurb ?? cap.description,
    href: extra?.href ?? cap.href,
  };
}

/** Ordered setup copy for every One capability, mirroring the catalog order. */
export const CAPABILITY_SETUP_COPY: readonly CapabilitySetupCopy[] =
  ONE_CAPABILITIES.map(toSetupCopy);

/** Lookup setup copy by capability id. */
export function getCapabilitySetupCopy(id: string): CapabilitySetupCopy | undefined {
  return CAPABILITY_SETUP_COPY.find((c) => c.id === id);
}
