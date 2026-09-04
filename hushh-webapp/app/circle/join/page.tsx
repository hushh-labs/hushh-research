"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Users } from "lucide-react";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  CaptionText,
  CardTitle,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  CIRCLE_JOIN_CODE_PARAM,
  formatCircleCodeForDisplay,
} from "@/lib/one-location/circle-join-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleInvitePreview } from "@/lib/one-location/types";
import { rememberPendingCircleJoin } from "@/lib/one-location/pending-circle-join";
import { ROUTES } from "@/lib/navigation/routes";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";

/**
 * An invitation is one short column. `width="reading"` (54rem) stretches it
 * into a banner on a laptop, and the measure cannot be a utility class: the
 * shell sets its width through `.app-page-shell[data-app-shell-width="reading"]`,
 * which outranks one. `AppPageShell` exports `APP_MEASURE_STYLES` for the same
 * reason -- an inline max-width is the established way to narrow a shell.
 */
const INVITE_MEASURE: CSSProperties = { maxWidth: "30rem" };

function joinPath(code: string): string {
  // Connect, not the Location agent (#5458).
  //
  // This used to land on `/one/location?action=join-circle`, where a first-run
  // onboarding takeover -- decided without reading any query parameter --
  // rendered instead, so somebody who tapped a friend's invite link was shown
  // "Share your location easily with anyone" rather than the code they were
  // handed. Circles live on Connect now, and the code field reads the same
  // parameter there.
  const query = new URLSearchParams({ tab: "circles", action: "join-circle" });
  if (code) query.set(CIRCLE_JOIN_CODE_PARAM, code);
  return `${ROUTES.CONNECT}?${query.toString()}`;
}

function loginHref(code: string): string {
  // Return to this same landing rather than to the hub, so the code survives
  // the round trip through sign-in and the preview below is what greets them.
  const here = `/circle/join?${CIRCLE_JOIN_CODE_PARAM}=${encodeURIComponent(code)}`;
  return `/login?redirect=${encodeURIComponent(here)}`;
}

// The API types these as required, but the backend coerces a missing owner to a
// placeholder and an unnamed Circle to "". Render what a person can read.
function circleName(preview: OneLocationCircleInvitePreview): string {
  return preview.name.trim() || "This Circle";
}

function memberSummary(preview: OneLocationCircleInvitePreview): string {
  const owner = preview.ownerDisplayName.trim() || "A Circle owner";
  if (preview.memberCount <= 0) return owner;
  const people =
    preview.memberCount === 1 ? "1 person" : `${preview.memberCount} people`;
  return `${owner} · ${people}`;
}

/**
 * Recipient landing for a shared Circle join link (`/circle/join?code=…`).
 *
 * This used to render nothing and redirect immediately. For a signed-in person
 * that was invisible and fine; for everyone else it was a bounce to a login
 * wall with no explanation of what they had tapped, and the invitation was the
 * only context they had. Someone deciding whether to share live location
 * deserves to see whose Circle it is first -- which is the one thing every
 * comparable product shows at this exact moment.
 *
 * Layout note: this route renders INSIDE the signed-in shell. Its contract
 * entry says `mode: "redirect"`, but only "flow", "hidden" and
 * `persistentChrome: "none"` change chrome, so the top bar and the bottom
 * "Talk to One" composer are both drawn here. The shell already reserves both
 * edges -- a spacer sized to `--app-top-content-offset` precedes this page and
 * the scroll root carries `--app-scroll-bottom-pad`. A viewport height here
 * therefore double-counts that reservation: it pushed the invitation into the
 * header and left a dead scroll region above the composer. `AppPageShell` with
 * `fitContent` is the primitive that measures to its content instead.
 */
function CircleJoinLanding() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();

  const code = (searchParams.get(CIRCLE_JOIN_CODE_PARAM) ?? "").trim();
  const [preview, setPreview] =
    useState<OneLocationCircleInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!code || !auth.user) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await auth.user.getIdToken();
      setPreview(
        await OneLocationService.previewOnboardingCircleCode({ idToken, code }),
      );
    } catch (caught) {
      // The service rethrows the transport error untouched, so `caught.message`
      // can be "Request failed: 422", "Rate limit exceeded: 10 per 1 minute" or
      // "Invalid Firebase ID token". None of that is readable, and none of it
      // tells the person what to do. Keep the detail in the console for
      // diagnostics and show one sentence they can act on.
      console.error("[circle-join] preview failed", caught);
      setError("That code didn't work. Ask for a new link.");
    } finally {
      setLoading(false);
    }
  }, [auth.user, code]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  // No code at all means the link was mangled in transit. Send them to the
  // hub, where they can type one, rather than showing an empty invitation.
  useEffect(() => {
    if (!code) router.replace(joinPath(""));
  }, [code, router]);

  // Effects run after paint, so rendering the invitation here would commit a
  // codeless "You're invited" -- and a sign-in link carrying an empty code --
  // for one frame before the redirect above fires.
  if (!code) return null;

  const showPreview = auth.isAuthenticated && !auth.loading;
  const canJoin = Boolean(preview) && !preview?.alreadyMember;

  return (
    <AppPageShell
      as="main"
      width="reading"
      fitContent
      style={INVITE_MEASURE}
      data-testid="circle-join-landing"
    >
      <PageHeader
        // The description is two lines; letting it share the icon row
        // stretched that row and pushed the tile away from the title.
        descriptionFullWidth
        title="You're invited"
        eyebrow="Circle invite"
        description="Your location stays private until you choose to share it."
        leading={
          <span className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
            <Users className="h-[22px] w-[22px]" aria-hidden="true" />
          </span>
        }
        testId="circle-join-header"
      />

      {/* One surface holds everything known about the invitation: the code the
          sender read out, and -- once it resolves -- whose Circle it is. Three
          floating blocks read as three unrelated things. */}
      <section
        className="mt-6 rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5"
        data-testid="circle-join-card"
      >
        <CaptionText className="text-muted-foreground">Invite code</CaptionText>
        <p
          className="mt-1 select-all break-all font-mono text-[19px] font-bold uppercase leading-6 tracking-[0.1em]"
          data-testid="circle-join-code"
        >
          {formatCircleCodeForDisplay(code)}
        </p>

        {showPreview ? (
          <div className="mt-4 border-t border-[color:var(--app-separator)] pt-4">
            {loading ? (
              <p className="flex items-center gap-2 text-[15px] leading-5 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Looking up this Circle
              </p>
            ) : preview ? (
              <div className="min-w-0" data-testid="circle-join-preview">
                <CardTitle className="break-words">
                  {circleName(preview)}
                </CardTitle>
                <RowDescription className="mt-1 break-words">
                  {memberSummary(preview)}
                </RowDescription>
                {preview.alreadyMember ? (
                  <RowDescription className="mt-2">
                    You&apos;re already in this Circle.
                  </RowDescription>
                ) : null}
              </div>
            ) : error ? (
              <p
                className="text-[15px] leading-5 text-[color:var(--app-destructive)]"
                data-testid="circle-join-error"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Pre-mounted so a screen reader announces the lookup result. An element
          that only exists once the message does is never announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading
          ? "Looking up this Circle"
          : error
            ? error
            : preview
              ? `${circleName(preview)}. ${memberSummary(preview)}.`
              : ""}
      </p>

      {showPreview ? (
        // Always offered, even when the lookup failed: the hub can take a
        // retyped code, so a bad preview is never the end of the road.
        <Button
          type="button"
          size="lg"
          className="mt-6 w-full"
          onClick={() => {
            const userId = auth.user?.uid;
            // Joining needs a vault, which exists only once /one/setup
            // finishes -- and /one/location itself is gated for a mid-setup
            // user, so the query-string code below would otherwise be
            // dropped by that redirect. Parking it here reuses the same
            // mechanism /one/location already redeems from the moment a
            // vault token exists, resolved or not, so the join survives an
            // unresolved bootstrap read too.
            if (userId && !OneSetupCompletionHintService.isResolved(userId)) {
              rememberPendingCircleJoin(userId, code);
            }
            router.replace(joinPath(code));
          }}
          data-testid="circle-join-continue"
        >
          {canJoin ? "Join this Circle" : "Open One"}
        </Button>
      ) : auth.loading ? (
        <p className="mt-6 flex items-center gap-2 text-[15px] leading-5 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking your account
        </p>
      ) : (
        <>
          <p className="mt-6 text-[15px] leading-5 text-muted-foreground">
            Sign in to see whose Circle this is.
          </p>
          <Button
            asChild
            size="lg"
            className="mt-4 w-full"
            data-testid="circle-join-sign-in"
          >
            <Link href={loginHref(code)}>Sign in</Link>
          </Button>
        </>
      )}
    </AppPageShell>
  );
}

export default function CircleJoinPage() {
  return (
    <Suspense fallback={null}>
      <CircleJoinLanding />
    </Suspense>
  );
}
