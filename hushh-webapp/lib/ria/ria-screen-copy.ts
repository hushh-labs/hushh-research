/**
 * RIA screen copy — single source of truth for the user-facing strings on the
 * RIA data screens (Home, Clients, Picks, Connect).
 *
 * Voice: Apple-clean and crisp — every line says the same thing in ~3 words.
 * Real page components import this directly; isolated UI-Dev previews can reuse
 * it so mockups do not drift from production copy.
 * Copy-only: changing a string here changes wording, never behaviour.
 *
 * Deep Picks editor/validation micro-copy stays inline in the page (not shown
 * in the mockups); only the primary visible strings live here.
 */

export const RIA_COPY = {
  home: {
    eyebrow: "RIA Home",
    title: "Trusted advisor ops",
    description: "See what's ready and what needs you.",
    verification: {
      active: {
        label: "Ready",
        title: "Your advisor workspace is ready.",
        description: "Relationships, picks, and requests — no setup needed.",
      },
      submitted: {
        label: "In review",
        title: "Verification is still moving.",
        description: "Trust checks are finishing in the background.",
      },
      rejected: {
        label: "Needs update",
        title: "A few details need another pass.",
        description: "Refresh your profile to keep access flowing.",
      },
      draft: {
        label: "Draft",
        title: "Finish advisor setup once.",
        description: "Then the rest stays in the background.",
      },
    },
    summary: {
      relationships: {
        label: "Relationships",
        has: "Active investor relationships.",
        empty: "No active relationships yet.",
      },
      priority: {
        label: "Priority queue",
        has: "Only real decisions show here.",
        empty: "Quiet until something needs action.",
      },
      invites: {
        label: "Open invites",
        has: "Links awaiting investor response.",
        empty: "No invites pending.",
      },
    },
    queue: {
      heading: "Priority queue",
      description: "Only things that need your move appear here.",
      loading: "Loading readiness and relationships.",
      empty: "Nothing urgent. New actions land here.",
      itemFallback: "Review the next step.",
      open: "Open",
    },
    iam: {
      title: "RIA home needs the IAM rollout",
      description: "This environment needs the IAM schema first.",
    },
  },

  clients: {
    eyebrow: "Clients",
    title: "Client roster",
    description: "One workspace per client — status, access, Kai, explorer.",
    section: {
      title: "Connected investors",
      description: "Status, access, Kai, and explorer in one place.",
    },
    loading: "Loading clients…",
    empty: "No connected investors yet.",
    browse: "Browse the marketplace",
    setupGate: {
      title: "Complete RIA onboarding",
      description: "Finish onboarding to open the roster.",
    },
    verifyGate: {
      eyebrow: "Verification required",
      title: "Verify your advisor account first",
      description: "Finish verification in onboarding to access investors.",
      body: "Locked until verification is complete.",
    },
  },

  picks: {
    eyebrow: "Picks",
    title: "Stock universe",
    description: "Switch Kai's package and yours — avoid and screening stay.",
    screening: {
      investable: {
        title: "Investable requirements",
        description: "Must-haves before a name enters debates.",
      },
      avoidTriggers: {
        title: "Automatic avoid triggers",
        description: "Hard stops that drop a name.",
      },
      math: {
        title: "The math",
        description: "Thresholds and scorecards for the engine.",
      },
    },
    emptyMyList: {
      title: "Build your live package",
      description:
        "Shape the package your investors debate. Start from Kai, edit tiers, or upload a CSV.",
    },
    avoidEmpty: {
      title: "Avoid list is empty",
      description: "Add names for Kai to exclude from debates.",
    },
    unlockRail: "Unlock the vault to edit or publish.",
  },

  connect: {
    eyebrow: "SEBI-registered network",
    title: "Connect",
    description: "Find a registered advisor. Connect with consent.",
    deckComplete: {
      title: "That's everyone for now",
      description: "You've seen everyone. More join soon.",
    },
    detail: {
      description: "Review before you connect.",
      strategyEmpty: "No public strategy yet.",
    },
    summaryFallback: "Check fit, then open the profile.",
    publicProfile: "Public advisory profile",
  },
} as const;

export type RiaScreenCopy = typeof RIA_COPY;
