"use client";

/**
 * Kill switch for the local-first onboarding sequence (dev-only, Workstream D).
 *
 * Every single person who signs up walks the onboarding flow, so a change to
 * its step order is exactly the kind of change `AGENTS.md` requires to ship
 * dark. The flag reads OFF when unset, so a half-configured environment keeps
 * today's sequence rather than a partially-wired new one.
 *
 * When OFF: `/one/setup` behaves exactly as it does today — Finish setup leads
 * straight to the vault invitation.
 * When ON: Finish setup leads to the guided connection screen, then the
 * buffered records migrate into PKM, then the vault explainers, then the same
 * unmodified vault flow.
 *
 * Turn-on condition: dev has run a full sign-up -> pod ready -> migration ->
 * vault pass with the buffer draining to zero, and `deploy-dev.yml` carries
 * `NEXT_PUBLIC_ONBOARDING_LOCAL_FIRST_ENABLED=1`.
 *
 * KNOWN LIMITATION: the guided-connection screen is shown when the person
 * finishes setup, not when the pod flips to `ready`. It reads readiness from
 * the feed page already loaded this session and adapts its headline honestly,
 * but it does not wait for readiness — onboarding is a flow every person walks,
 * and blocking it on a fresh network read would trade a real reliability risk
 * for a line of copy.
 */

const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

export function isLocalFirstOnboardingEnabled(): boolean {
  return TRUTHY_FLAG_VALUES.has(
    String(process.env.NEXT_PUBLIC_ONBOARDING_LOCAL_FIRST_ENABLED || "")
      .trim()
      .toLowerCase(),
  );
}
