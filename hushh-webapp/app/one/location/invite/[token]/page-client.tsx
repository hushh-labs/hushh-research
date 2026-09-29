"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  ShieldCheck,
  UserPlus,
} from "@/components/icons";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  roleClasses,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
} from "@/lib/navigation/routes";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleInvite } from "@/lib/one-location/types";
import { ApiError } from "@/lib/services/api-client";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ConnectionsService } from "@/lib/services/connections-service";
import { useVault } from "@/lib/vault/vault-context";
import { GuestPreview } from "@/components/onboarding/guest-preview";
import { HushhLoader } from "@/components/app-ui/hushh-loader";

/**
 * A claim that threw is a hard failure, not something to look at later. The
 * warning family means pending / expiring / needs review, so painting a
 * failure with it told the reader the opposite of what happened.
 */
const CLAIM_FAILURE_TONE = roleClasses("danger");

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ownerLabel(invite: OneLocationCircleInvite | null): string {
  return invite?.ownerLabel || "a trusted person";
}

function loginHref(returnTo: string): string {
  return `/login?redirect=${encodeURIComponent(returnTo)}`;
}

function isPhoneVerificationRequiredError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 409) return false;
  const message = error.message.toLowerCase();
  let payloadCode = "";
  if (error.payload && typeof error.payload === "object" && !Array.isArray(error.payload)) {
    const payload = error.payload as Record<string, unknown>;
    const detail = payload.detail;
    if (typeof payload.code === "string") {
      payloadCode = payload.code;
    } else if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const detailCode = (detail as Record<string, unknown>).code;
      payloadCode = typeof detailCode === "string" ? detailCode : "";
    }
  }
  return (
    payloadCode === "LOCATION_PHONE_VERIFICATION_REQUIRED" ||
    (message.includes("phone") && message.includes("verify"))
  );
}

export default function OneLocationCircleInvitePageClient({
  token,
  returnTo,
}: { token?: string; returnTo?: string } = {}) {
  const router = useRouter();
  const params = useParams<{ token?: string }>();
  const auth = useAuth();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { isVaultUnlocked, vaultOwnerToken, vaultKey } = useVault();
  const inviteToken = useMemo(
    () => String(token ?? params?.token ?? "").trim(),
    [token, params?.token],
  );
  const invitePath = returnTo ?? `/one/location/invite/${encodeURIComponent(inviteToken)}`;
  const claimScope = useRef({ active: true });
  useEffect(() => {
    const scope = { active: true };
    claimScope.current = scope;
    return () => { scope.active = false; };
  }, [auth.userId, inviteToken]);
  const [invite, setInvite] = useState<OneLocationCircleInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [phoneVerificationRequired, setPhoneVerificationRequired] =
    useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadInvite = async () => {
      setLoading(true);
      setError(null);
      setInvite(null);
      setClaimed(false);
      setClaiming(false);
      setClaimError(null);
      setUnavailable(false);
      try {
        const response = await OneLocationService.resolveCircleInvite(inviteToken);
        if (!cancelled) setInvite(response.invite);
      } catch (loadError) {
        if (!cancelled) {
          setUnavailable(loadError instanceof ApiError && [400, 404, 410, 422].includes(loadError.status));
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This Invite to One link is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (inviteToken) {
      void loadInvite();
    } else {
      setUnavailable(true);
      setError("This Invite to One link is invalid.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  useEffect(() => {
    if (!auth.user || !auth.userId || auth.loading) {
      setCheckingPhone(false);
      setPhoneVerificationRequired(false);
      return;
    }

    let cancelled = false;
    setCheckingPhone(true);
    void AccountIdentityService.syncCurrentUser(auth.user)
      .then((identity) => {
        if (cancelled) return;
        setPhoneVerificationRequired(
          !AccountIdentityService.hasVerifiedPhone(identity),
        );
      })
      .catch((syncError) => {
        if (cancelled) return;
        console.warn("[OneLocationInvite] Failed to check account identity:", syncError);
        setPhoneVerificationRequired(false);
      })
      .finally(() => {
        if (!cancelled) setCheckingPhone(false);
      });

    return () => {
      cancelled = true;
    };
  }, [auth.loading, auth.user, auth.userId]);

  const handleClaim = useCallback(async () => {
    if (!auth.userId || !vaultOwnerToken) return;
    const scope = claimScope.current;
    setClaiming(true);
    setClaimError(null);
    setPhoneVerificationRequired(false);
    try {
      await AccountIdentityService.syncCurrentUser(auth.user).catch((syncError) => {
        console.warn("[OneLocationInvite] Failed to sync account identity:", syncError);
      });
      if (!scope.active) return;
      await bootstrapCurrentUserLocationRecipientKey({
        userId: auth.userId,
        vaultOwnerToken,
        vaultKey,
      });
      if (!scope.active) return;
      const claimResult = await OneLocationService.claimCircleInvite({
        vaultOwnerToken,
        inviteToken,
        message: "Joined from an Invite to One link.",
      });
      if (!scope.active) return;
      // Best-effort: materialize a connection so the inviter and claimant become
      // One Location recipients of each other. Backend endpoint is dormant and
      // only runs because of this call — remove this block to disable the link.
      const peerUserId = claimResult?.connection?.inviterUserId;
      if (peerUserId && auth.user) {
        try {
          const idToken = await auth.user.getIdToken();
          if (!scope.active) return;
          await ConnectionsService.linkCircleInvite({ idToken, peerUserId });
        } catch (linkError) {
          console.warn(
            "[OneLocationInvite] Failed to link circle invite into a connection:",
            linkError,
          );
        }
      }
      if (!scope.active) return;
      setClaimed(true);
      toast.success("You're connected on One.");
      router.push("/one/location?section=circle");
    } catch (claimError) {
      if (!scope.active) return;
      const message =
        claimError instanceof Error
          ? claimError.message
          : "Could not accept this Invite to One link.";
      setClaimError(message);
      if (isPhoneVerificationRequiredError(claimError)) {
        setPhoneVerificationRequired(true);
      }
      toast.error(message);
    } finally {
      if (scope.active) setClaiming(false);
    }
  }, [auth.user, auth.userId, inviteToken, router, vaultOwnerToken, vaultKey]);

  // The glyph in this bubble already switches between three opposite
  // meanings; the bubble itself used to stay action-blue through all of
  // them, so an unusable link and a completed join were painted as the
  // same "do this" colour. Colour now says what the glyph says.
  // The resting state stays `action`: an open invitation to a Location
  // surface is exactly the map/CTA affordance that owns accent blue.
  const headerRole: SemanticRole = error
    ? "danger"
    : claimed
      ? "success"
      : "action";
  const headerTone = roleClasses(headerRole);

  const signedIn = Boolean(auth.userId && auth.isAuthenticated);
  const canClaim =
    signedIn &&
    isVaultUnlocked &&
    Boolean(vaultOwnerToken) &&
    !claimed &&
    !phoneVerificationRequired;

  if (!hydrated || auth.loading) return <HushhLoader label="Checking your account" />;

  if (!signedIn) {
    return <GuestPreview key={inviteToken} invitation={{ kind: "connection", ownerName: invite?.ownerLabel ?? undefined, loading, unavailable, error: error ? unavailable ? "This invitation is unavailable. Ask for a new link." : "Preview is temporarily unavailable. You can still sign in." : null }} onStart={() => router.push(loginHref(invitePath))} />;
  }

  return (
    // No height floor. min-h-screen compiles to 100vh, which in a WKWebView
    // does not shrink for chrome or safe areas, so it renders taller than the
    // visible viewport. The scroll root already fills the screen.
    <main className="bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[720px] flex-col px-5 pb-10 pt-[max(48px,calc(env(safe-area-inset-top)+28px))] sm:px-6 sm:pt-[max(64px,calc(env(safe-area-inset-top)+40px))]">
        <div className="space-y-6 rounded-[var(--app-card-radius-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-none sm:p-6">
          <div className="flex items-start gap-4">
            <div
              className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] ${headerTone.tile} ${headerTone.glyph}`}
            >
              {error ? (
                <AlertTriangle className="h-[17px] w-[17px]" aria-hidden="true" />
              ) : claimed ? (
                <CheckCircle2 className="h-[17px] w-[17px]" aria-hidden="true" />
              ) : (
                <MapPin className="h-[17px] w-[17px]" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                Location
              </div>
              <h1 className="ui-text-agent-title mt-1">
                Join One
              </h1>
              <p className="mt-3 text-[15px] font-normal leading-[20px] text-muted-foreground">
                {loading
                  ? "Checking Invite to One link."
                  : error
                    ? error
                    : claimed
                      ? "You're connected on One."
                      : `${ownerLabel(invite)} invited you to One.`}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-10 w-36 rounded-xl" />
            </div>
          ) : null}

          {!loading && invite ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge variant="secondary">
                  Expires {formatDateTime(invite.expiresAt)}
                </Badge>
                <Badge variant="outline">
                  {invite.durationHours}h invite window
                </Badge>
              </div>

              {invite.message ? (
                <div className="rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-compact)] p-4 text-[15px] leading-5 text-muted-foreground">
                  {invite.message}
                </div>
              ) : null}

              <div className="rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-accent-tint)] p-4 text-[15px] leading-5 text-foreground">
                Accepting connects both of you on One. Live location still starts only
                when someone taps Share Location, confirms permission, and sends an
                encrypted share from Location.
              </div>

              {claimError ? (
                <div
                  className={`rounded-[var(--app-card-radius-compact)] p-4 text-[15px] leading-5 ${CLAIM_FAILURE_TONE.tile} ${CLAIM_FAILURE_TONE.glyph}`}
                >
                  {claimError}
                </div>
              ) : null}

              {auth.loading || checkingPhone ? (
                <Button disabled className="h-11 rounded-full">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  {auth.loading ? "Checking sign in" : "Checking phone"}
                </Button>
              ) : !signedIn ? (
                <Button asChild className="h-11 rounded-full">
                  <Link href={loginHref(invitePath)}>
                    <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                    Sign in to join
                  </Link>
                </Button>
              ) : phoneVerificationRequired ? (
                <Button asChild className="h-11 rounded-full">
                  <Link href={buildPhoneMandateRoute(invitePath)}>
                    <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                    Verify phone to continue
                  </Link>
                </Button>
              ) : !isVaultUnlocked || !vaultOwnerToken ? (
                <Button asChild className="h-11 rounded-full">
                  <Link href={buildProfileVaultRoute(invitePath)}>
                    <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                    Continue to Vault
                  </Link>
                </Button>
              ) : (
                <Button
                  onClick={() => void handleClaim()}
                  disabled={!canClaim || claiming}
                  className="h-11 rounded-full"
                >
                  {claiming ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  Accept Invite
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
