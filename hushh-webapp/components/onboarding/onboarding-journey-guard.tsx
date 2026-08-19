"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import {
  isCapabilityOnboardingRoute,
  isOneSetupSurfaceRoute,
  normalizeStaticExportPathname,
  resolveCapabilityHandoffTarget,
  resolveSetupCapabilityIdForPath,
  ROUTES,
} from "@/lib/navigation/routes";
import { useOnboardingEntry } from "@/lib/onboarding/onboarding-entry-context";
import {
  isEntryExemptRoute,
  isOnboardingRoute,
  type UserEntryState,
  type UserEntryStep,
} from "@/lib/onboarding/user-entry-state";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

/**
 * The app-wide router for the first-run journey.
 *
 * It does not work out where somebody belongs — `OnboardingEntryProvider` did
 * that already, once, for the whole app. This decides one thing: whether the
 * route on screen is the one that decision names, and moves the person if it
 * is not.
 *
 * Two rules, and they are the whole component:
 *
 *  1. Nothing renders until the decision is resolved. Not the route, not a
 *     guess at the route. An unresolved decision shows a loader, so no screen
 *     can appear and then be replaced a tick later.
 *  2. The funnel is one-way. A person who finished it cannot be on one of its
 *     screens — by back button, back gesture, deep link, typed URL, or a
 *     history entry left behind by the sign-in provider's own page load. Every
 *     arrival path passes through here, so one check covers all of them.
 *
 * Redirects always `replace`, never `push`: a funnel screen must not survive in
 * history to be reachable again.
 */
export function OnboardingJourneyGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { entry, activeCapability, failed, funnelExitInFlight, retry } =
    useOnboardingEntry();

  const normalizedPathname = normalizeStaticExportPathname(pathname);
  const exempt = isEntryExemptRoute(pathname);
  const setupSurface = isOneSetupSurfaceRoute(pathname);


  // Read query and hash from the window rather than useSearchParams: this guard
  // wraps every route including the 404 shell, and a CSR bailout there would
  // break the static prerender the native shell is built from.
  const currentHref = useMemo(() => {
    if (typeof window === "undefined") return pathname;
    return `${pathname}${window.location.search}${window.location.hash}`;
  }, [pathname]);

  const target = resolveRedirectTarget({
    activeCapability,
    entry,
    funnelExitInFlight,
    exempt,
    normalizedPathname,
    pathname,
    setupSurface,
    currentHref,
  });

  const redirectingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target) {
      redirectingRef.current = null;
      return;
    }
    if (redirectingRef.current === target) return;
    redirectingRef.current = target;
    // Stay inside the App Router. A document navigation here would destroy the
    // in-memory lock key and drop the person back at the unlock screen.
    router.replace(target);
  }, [router, target]);

  const passThrough = exempt || (entry.resolved && !entry.signedIn);
  const holding = !passThrough && (!entry.resolved || Boolean(target));

  // Hide the persistent shell while the decision paints its loader, so the
  // top tabs and bottom bar never leak around it.
  useSessionChromeSuppression(holding);

  if (passThrough) return <>{children}</>;

  // Before the loader, not after it. A record that cannot be read leaves the
  // decision permanently unresolved, so checking `holding` first would spin a
  // loader forever with no way back — which is worse than the problem it was
  // meant to cover.
  if (failed) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card/70 p-4 text-center">
          <p className="text-sm text-foreground">
            Couldn&apos;t check your setup. Try again.
          </p>
          <Button size="sm" className="mt-3" onClick={retry}>
            Retry
          </Button>
          <Button
            size="sm"
            variant="muted"
            effect="fade"
            className="mt-3"
            onClick={() => router.push(ROUTES.PROFILE)}
          >
            Open profile
          </Button>
        </div>
      </div>
    );
  }

  if (holding) {
    return <HushhLoader label={holdingLabel(entry.step, target)} />;
  }

  return <>{children}</>;
}

/**
 * The one route this person may be on, or null when they are already on it.
 *
 * Order matters. The funnel check runs before the admission check because a
 * finished person standing on a funnel screen has to leave it whatever else is
 * true of the route.
 */
function resolveRedirectTarget(params: {
  activeCapability: string | null;
  entry: UserEntryState;
  funnelExitInFlight: boolean;
  exempt: boolean;
  normalizedPathname: string;
  pathname: string;
  setupSurface: boolean;
  currentHref: string;
}): string | null {
  const { entry, exempt, normalizedPathname, pathname, setupSurface } = params;
  if (exempt) return null;
  if (!entry.resolved) return null;
  if (!entry.signedIn) return null;

  // Rule 2 — the funnel is one-way. A signed-in person on a funnel screen that
  // is not the step they are actually on gets moved to the one that is.
  // The hub is finishing and owns the move it started. Stepping in here would
  // unmount it before it can run, and it is the only one that knows when the
  // destination is the portfolio-import step rather than home.
  if (params.funnelExitInFlight && setupSurface) return null;

  if (isOnboardingRoute(pathname)) {
    const destination = normalizeStaticExportPathname(entry.destination);
    return normalizedPathname === destination ? null : entry.destination;
  }

  // A capability handoff under `/one/setup/<id>` is part of the funnel while it
  // runs, and stops being reachable once the funnel is behind the person. The
  // investor-preferences wizard is the exception: it stays a valid entry after
  // root completion, and its import terminal with it.
  const isPostRootFinanceSetup =
    normalizedPathname === ROUTES.ONE_SETUP_FINANCE ||
    normalizedPathname === ROUTES.ONE_SETUP_FINANCE_IMPORT;
  if (setupSurface) {
    if (entry.step === "main_app" && !isPostRootFinanceSetup) {
      // A finished person standing on a stale `/one/setup/<id>` link (an old
      // tile href, back/forward, a bookmark) still named a capability they
      // were after. Land them on that capability's own workspace, the exact
      // destination every roster tile already sends a finished person to
      // directly — not on the bare hub's home fallback, which drops it.
      const capabilityId = resolveSetupCapabilityIdForPath(normalizedPathname);
      return capabilityId
        ? resolveCapabilityHandoffTarget(capabilityId)
        : ROUTES.ONE_HOME;
    }
    return null;
  }

  // Rule 1's other half — a product route stays shut until the funnel is done.
  // Finishing one capability is not enough; only the hub's Finish action is.
  if (entry.step === "vault_setup" || entry.step === "one_setup") {
    if (isCapabilityOnboardingRoute(params.activeCapability, pathname)) {
      return null;
    }
    return buildSetupReturn(params.currentHref);
  }

  return null;
}

function buildSetupReturn(currentHref: string): string {
  const returnTo = encodeURIComponent(currentHref);
  return `${ROUTES.ONE_SETUP}?return_to=${returnTo}`;
}

function holdingLabel(step: UserEntryStep, target: string | null): string {
  if (!target) return "Checking setup...";
  if (target === ROUTES.ONE_HOME) return "Opening One...";
  if (step === "phone_auth") return "Opening phone verification...";
  if (target.startsWith(`${ROUTES.ONE_SETUP}?`)) return "Returning to setup...";
  return "Opening...";
}
