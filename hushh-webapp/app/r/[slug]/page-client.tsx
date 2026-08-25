"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";

import { CardTitle, RowDescription } from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import {
  clearPendingAttribution,
  rememberPendingAttribution,
} from "@/lib/referral/pending-attribution";
import { ReferralService } from "@/lib/services/referral-service";

/**
 * A referral link: /r/<slug>.
 *
 * The only job of this screen is to record the attribution on the SERVER before
 * anyone signs in, keep the opaque id it is given, and get out of the way. It
 * never shows who the referrer is -- a slug is public, so anyone can open
 * anyone's link, and confirming whose it is would leak the owner to whoever
 * guessed it.
 *
 * An unavailable slug is not an error state. The person still came here wanting
 * to join, so they are still sent into the normal journey; they simply arrive
 * unattributed.
 */
function signInHref(): string {
  return `/login?redirect=${encodeURIComponent(ROUTES.ONE_HOME)}`;
}

export default function ReferralLandingPageClient({ slug }: { slug: string }) {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [handedOff, setHandedOff] = useState(false);

  // Strict Mode mounts effects twice in development. Resolving twice would burn
  // two attributions for one tap.
  const resolved = useRef(false);

  useEffect(() => {
    if (resolved.current) return;
    resolved.current = true;

    let cancelled = false;

    void (async () => {
      try {
        const result = await ReferralService.resolve(slug, `/r/${slug}`);
        if (cancelled) return;
        if (result.status === "created" && result.attribution_id) {
          rememberPendingAttribution(result.attribution_id);
        } else {
          // Nothing to carry. Drop any older handle rather than letting a
          // stale one attach itself to this journey.
          clearPendingAttribution();
        }
      } catch {
        if (!cancelled) clearPendingAttribution();
      } finally {
        if (!cancelled) setHandedOff(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Hand off only once the attribution attempt has settled, so the id is stored
  // before the sign-in flow takes the document with it.
  //
  // A signed-out visitor goes through /login with a redirect back into the app,
  // which is the same mechanism the Circle join landing uses. A signed-in one
  // goes straight to One: the attribution is already recorded, and binding
  // happens on the authenticated side.
  useEffect(() => {
    if (!handedOff || loading) return;
    router.replace(user ? ROUTES.ONE_HOME : signInHref());
  }, [handedOff, loading, router, user]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span
        className="flex size-12 items-center justify-center rounded-full bg-muted"
        aria-hidden="true"
      >
        <Users className="size-6" />
      </span>
      <CardTitle>Joining One</CardTitle>
      <RowDescription>One moment.</RowDescription>
      <Button
        variant="secondary"
        onClick={() => router.replace(user ? ROUTES.ONE_HOME : signInHref())}
      >
        Continue
      </Button>
    </div>
  );
}
