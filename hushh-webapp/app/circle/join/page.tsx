"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Users } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  CIRCLE_JOIN_CODE_PARAM,
  formatCircleCodeForDisplay,
} from "@/lib/one-location/circle-join-url";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleInvitePreview } from "@/lib/one-location/types";

function joinPath(code: string): string {
  const query = new URLSearchParams({ action: "join-circle" });
  if (code) query.set(CIRCLE_JOIN_CODE_PARAM, code);
  return `/one/location?${query.toString()}`;
}

function loginHref(code: string): string {
  // Back to this same landing rather than to the hub, so the code survives the
  // round trip through sign-in and the preview below is what greets them.
  const here = `/circle/join?${CIRCLE_JOIN_CODE_PARAM}=${encodeURIComponent(code)}`;
  return `/login?redirect=${encodeURIComponent(here)}`;
}

/**
 * Recipient landing for a shared Circle join link (`/circle/join?code=…`).
 *
 * This used to render nothing and redirect immediately. For a signed-in person
 * that was invisible and fine; for everyone else it was a bounce to a login
 * wall with no explanation of what they had tapped, and the invitation was the
 * only context they had. Someone deciding whether to share their live location
 * deserves to see whose Circle it is first -- which is the one thing every
 * comparable product shows at this exact moment.
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
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "That code did not match a Circle. Ask for a fresh one.",
      );
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

  return (
    <main className="mx-auto flex min-h-[100svh] w-full max-w-[30rem] flex-col justify-center px-6 py-12">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
        <Users className="h-7 w-7" strokeWidth={2} />
      </span>

      <h1 className="ui-text-agent-title mt-5 text-balance">
        You&apos;ve been invited to a Circle
      </h1>

      {code ? (
        <p
          className="mt-3 select-all font-mono text-[clamp(18px,5.5vw,24px)] font-bold uppercase tracking-[0.12em]"
          data-testid="circle-join-code"
        >
          {formatCircleCodeForDisplay(code)}
        </p>
      ) : null}

      {auth.loading ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking your account
        </p>
      ) : !auth.isAuthenticated ? (
        <>
          <p className="mt-4 text-[15px] leading-6 text-muted-foreground">
            Sign in to see whose Circle this is. Your location stays private
            until you choose to share it.
          </p>
          <Link
            href={loginHref(code)}
            className="press-scale mt-6 flex h-14 w-full items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[17px] font-bold text-[color:var(--app-accent-fg)]"
            data-testid="circle-join-sign-in"
          >
            Sign in to continue
          </Link>
        </>
      ) : (
        <>
          {loading ? (
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Looking up this Circle
            </p>
          ) : preview ? (
            <div
              className="mt-6 rounded-[20px] border border-border/60 bg-muted/30 p-5"
              data-testid="circle-join-preview"
            >
              <p className="text-[17px] font-bold leading-6">{preview.name}</p>
              <p className="mt-1 text-[14px] leading-5 text-muted-foreground">
                {preview.ownerDisplayName} &middot; {preview.memberCount}{" "}
                {preview.memberCount === 1 ? "person" : "people"}
              </p>
              {preview.alreadyMember ? (
                <p className="mt-3 text-[14px] leading-5 text-muted-foreground">
                  You&apos;re already in this Circle.
                </p>
              ) : null}
            </div>
          ) : error ? (
            <p
              className="mt-6 text-[15px] leading-6 text-[color:var(--app-danger,#c8372d)]"
              role="status"
            >
              {error}
            </p>
          ) : null}

          {/* Always offered, even when the lookup failed: the hub can take a
              retyped code, so a bad preview is never the end of the road. */}
          <button
            type="button"
            onClick={() => router.replace(joinPath(code))}
            className="press-scale mt-6 flex h-14 w-full items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[17px] font-bold text-[color:var(--app-accent-fg)]"
            data-testid="circle-join-continue"
          >
            {preview && !preview.alreadyMember
              ? `Join ${preview.name}`
              : "Open One Location"}
          </button>
        </>
      )}
    </main>
  );
}

export default function CircleJoinPage() {
  return (
    <Suspense fallback={null}>
      <CircleJoinLanding />
    </Suspense>
  );
}
