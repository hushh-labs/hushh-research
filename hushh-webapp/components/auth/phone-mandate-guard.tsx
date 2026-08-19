"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { buildPhoneMandateRoute } from "@/lib/navigation/routes";
import { isPhoneMandatePath } from "@/lib/services/phone-mandate-service";
import { useOnboardingEntry } from "@/lib/onboarding/onboarding-entry-context";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

/**
 * Sends somebody to phone verification when that is the step they are on.
 *
 * It no longer works out whether that is the step. It used to: it fetched the
 * durable record itself, read the lock state from a second store with its own
 * precedence, and reached its own verdict — which is how it and the lock gate
 * could disagree about the same account and each paint a screen. The verdict
 * now comes from `OnboardingEntryProvider`, which resolves it once for the
 * whole app. All that is left here is enforcement.
 *
 * It must sit OUTSIDE the lock gate wherever both apply. Verifying an identity
 * comes before setting a lock, so the lock gate is the one that waits.
 */
export function PhoneMandateGuard({
  children,
  exemptVaultUsers = false,
}: {
  children: React.ReactNode;
  exemptVaultUsers?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { entry, hasVault } = useOnboardingEntry();
  const redirectTargetRef = useRef<string | null>(null);

  const currentRoute = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  // A couple of surfaces stay open to somebody who already owns a lock even
  // without a verified phone — an established account must not be locked out
  // of Profile, which is where sign-out and account deletion live.
  const waivedForVaultOwner = exemptVaultUsers && hasVault === true;

  const shouldRedirect =
    entry.step === "phone_auth" &&
    !waivedForVaultOwner &&
    !isPhoneMandatePath(pathname);

  useSessionChromeSuppression(!entry.resolved || shouldRedirect);

  useEffect(() => {
    if (!shouldRedirect) {
      redirectTargetRef.current = null;
      return;
    }
    const redirectTarget = buildPhoneMandateRoute(currentRoute);
    if (redirectTargetRef.current === redirectTarget) return;
    redirectTargetRef.current = redirectTarget;
    router.replace(redirectTarget);
  }, [currentRoute, router, shouldRedirect]);

  // Nothing renders from a guess. Until the decision is resolved there is no
  // way to know whether this route belongs to this person, and a screen shown
  // now is a screen replaced a tick later.
  if (!entry.resolved) {
    return <HushhLoader label="Checking session..." />;
  }

  // An anonymous visitor is somebody else's problem: the route's own sign-in
  // gate owns that redirect, and public routes legitimately have none.
  if (!entry.signedIn) {
    return <>{children}</>;
  }

  if (shouldRedirect) {
    return <HushhLoader label="Opening phone verification..." />;
  }

  return <>{children}</>;
}
