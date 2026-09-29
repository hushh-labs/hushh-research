"use client";

import { Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Users } from "@/components/icons";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import OneLocationCircleInvitePageClient from "@/app/one/location/invite/[token]/page-client";
import { GuestPreview } from "@/components/onboarding/guest-preview";
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
  ONE_INVITE_TOKEN_PARAM,
  buildOneInviteLandingPath,
  formatCircleCodeForDisplay,
} from "@/lib/one-location/circle-join-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleInvitePreview } from "@/lib/one-location/types";
import { INVITE_TO_ONE_PATH, ROUTES } from "@/lib/navigation/routes";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { ApiError } from "@/lib/services/api-client";

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

function GuestCirclePreview({ code }: { code: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<{
    name: string;
    ownerDisplayName: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!code) {
      setLoading(false);
      setUnavailable(true);
      setError("This invitation is missing its code. Ask for a new link.");
      return;
    }
    let active = true;
    setLoading(true);
    setPreview(null);
    setError(null);
    setUnavailable(false);
    void OneLocationService.previewPublicCircleCode(code)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((failure: unknown) => {
        if (active) {
          const invalid =
            failure instanceof ApiError &&
            [400, 404, 410, 422].includes(failure.status);
          setUnavailable(invalid);
          setError(
            invalid
              ? "This invitation is unavailable. Try again or ask for a new link."
              : "Preview is temporarily unavailable. You can still sign in to check this invitation.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [code, attempt]);
  return (
    <GuestPreview
      invitation={{
        kind: "circle",
        name: preview?.name,
        ownerName: preview?.ownerDisplayName,
        loading,
        error,
        unavailable,
        onRetry: () => setAttempt((value) => value + 1),
      }}
      onStart={() => router.push(loginHref(code))}
    />
  );
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
 * Guests get the same three-screen introduction as Invite to One. Only the
 * public metadata allowlist is loaded before authentication. Signed-in people
 * retain the membership-aware preview and explicit, protected Connect handoff.
 * The route contract removes persistent chrome, leaving the guest flow in
 * charge of its viewport and the signed-in preview sized to its content.
 */
function CircleJoinLanding() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();

  const code = (searchParams.get(CIRCLE_JOIN_CODE_PARAM) ?? "").trim();
  const [preview, setPreview] = useState<OneLocationCircleInvitePreview | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const continuationScope = useRef({ active: true });
  useEffect(() => {
    const scope = { active: true };
    continuationScope.current = scope;
    setContinuing(false);
    return () => { scope.active = false; };
  }, [auth.user?.uid, code]);

  useEffect(() => {
    let active = true;
    setPreview(null);
    if (!code || !auth.user) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const idToken = await auth.user!.getIdToken();
        const result = await OneLocationService.previewOnboardingCircleCode({
          idToken,
          code,
        });
        if (active) setPreview(result);
      } catch (caught) {
        if (!active) return;
        console.error("[circle-join] preview failed", caught);
        setError("That code didn't work. Ask for a new link.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.user, code]);

  // A signed-in person can enter a missing code in Connect. Guests still get
  // the introduction first, not an accidental immediate login redirect.
  useEffect(() => {
    if (!code && auth.user && !auth.loading) router.replace(joinPath(""));
  }, [auth.loading, auth.user, code, router]);

  if (auth.loading) return <HushhLoader label="Checking your account" />;

  if (!auth.user) return <GuestCirclePreview key={code} code={code} />;
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
          disabled={continuing}
          onClick={async () => {
            if (!auth.user || continuing) return;
            const scope = continuationScope.current;
            setContinuing(true);
            try {
              const next = await PostAuthRouteService.resolveAfterLogin({
                userId: auth.user.uid,
                idToken: await auth.user.getIdToken(),
                redirectPath: joinPath(code),
              });
              if (scope.active) router.replace(next);
            } catch {
              if (scope.active) toast.error("Could not continue. Please try again.");
            } finally {
              if (scope.active) setContinuing(false);
            }
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

function InvitationLanding() {
  const params = useSearchParams();
  const auth = useAuth();
  // Auth may settle before this streamed Suspense boundary hydrates. Keep
  // both the page and its native readiness marker identical on the first paint.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const tokens = params.getAll(ONE_INVITE_TOKEN_PARAM);
  const codes = params.getAll(CIRCLE_JOIN_CODE_PARAM);
  const token = tokens[0] ?? "";
  // A link must identify one invitation, never silently choose between two.
  const invalid =
    codes.length > 1 ||
    (tokens.length > 0 &&
      (tokens.length !== 1 ||
        !/^[A-Za-z0-9_-]+$/.test(token) ||
        codes.length > 0));
  if (!hydrated) return <HushhLoader label="Checking your account" />;
  return (
    <>
      <NativeTestBeacon
        routeId={ROUTES.CIRCLE_JOIN}
        marker="native-route-circle-join"
        authState={
          auth.loading ? "pending" : auth.user ? "authenticated" : "anonymous"
        }
        dataState={invalid ? "unavailable-valid" : "loaded"}
      />
      {invalid ? (
        <AppPageShell as="main" width="reading" fitContent>
          <PageHeader
            title="Invitation unavailable"
            description="Ask the sender for a new invitation link."
          />
          <Button asChild className="mt-6">
            <Link href={INVITE_TO_ONE_PATH}>Explore One</Link>
          </Button>
        </AppPageShell>
      ) : token ? (
        <OneLocationCircleInvitePageClient
          key={token}
          token={token}
          returnTo={buildOneInviteLandingPath(token)}
        />
      ) : (
        <CircleJoinLanding />
      )}
    </>
  );
}

export default function CircleJoinPage() {
  return (
    <Suspense fallback={null}>
      <InvitationLanding />
    </Suspense>
  );
}
