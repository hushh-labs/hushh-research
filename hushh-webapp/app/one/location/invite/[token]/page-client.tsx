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
  ROUTES,
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

function InviterIdentity({ label }: { label: string }) {
  // Legacy labels append an ASCII asterisk mask. Render a consistent mask on
  // one baseline, keeping the name and suffix separate at narrow widths.
  const match = label.match(/^(?:(.*?)\s*[-–—]\s*)?[*•●xX]{2,}\s*(\d{4})\s*$/u);
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-1">
      <span data-location-type-role="row-description" className="min-w-0 [overflow-wrap:anywhere]">{match ? match[1]?.trim() || "A trusted person" : label}</span>
      {match ? <span data-location-type-role="row-description" className="inline-block whitespace-nowrap tabular-nums" aria-label={`Phone ending in ${match[2]}`}>•••• {match[2]}</span> : null}
    </span>
  );
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
  const claimScope = useRef({ active: true, busy: false });
  useEffect(() => {
    const scope = { active: true, busy: false };
    claimScope.current = scope;
    return () => { scope.active = false; };
  }, [auth.userId, inviteToken]);
  const [invite, setInvite] = useState<OneLocationCircleInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteLoadAttempt, setInviteLoadAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [phoneCheckError, setPhoneCheckError] = useState(false);
  const [phoneCheckAttempt, setPhoneCheckAttempt] = useState(0);
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
  }, [inviteToken, inviteLoadAttempt]);

  useEffect(() => {
    if (!auth.user || !auth.userId || auth.loading) {
      setCheckingPhone(false);
      setPhoneVerificationRequired(false);
      return;
    }

    let cancelled = false;
    setCheckingPhone(true);
    setPhoneCheckError(false);
    setPhoneVerificationRequired(false);
    void AccountIdentityService.syncCurrentUser(auth.user)
      .then((identity) => {
        if (cancelled) return;
        if (typeof identity?.phone_verified !== "boolean") {
          setPhoneCheckError(true);
          return;
        }
        setPhoneVerificationRequired(
          !AccountIdentityService.hasVerifiedPhone(identity),
        );
      })
      .catch((syncError) => {
        if (cancelled) return;
        console.warn("[OneLocationInvite] Failed to check account identity:", syncError);
        setPhoneCheckError(true);
      })
      .finally(() => {
        if (!cancelled) setCheckingPhone(false);
      });

    return () => {
      cancelled = true;
    };
  }, [auth.loading, auth.user, auth.userId, phoneCheckAttempt]);

  const handleClaim = useCallback(async () => {
    if (!auth.userId || !vaultOwnerToken || checkingPhone || phoneCheckError || phoneVerificationRequired) return;
    const scope = claimScope.current;
    if (scope.busy) return;
    scope.busy = true;
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
      scope.busy = false;
      if (scope.active) setClaiming(false);
    }
  }, [auth.user, auth.userId, inviteToken, router, vaultOwnerToken, vaultKey, checkingPhone, phoneCheckError, phoneVerificationRequired]);

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
    !phoneVerificationRequired && !checkingPhone && !phoneCheckError;

  if (!hydrated || auth.loading) return <HushhLoader label="Checking your account" className="ui-text-status [&>p]:[font:inherit]" />;

  if (!signedIn) {
    return <GuestPreview key={inviteToken} locationTypography invitation={{ kind: "connection", ownerName: invite?.ownerLabel ?? undefined, loading, unavailable, error: error ? unavailable ? "This invitation is unavailable. Ask for a new link." : "Preview is temporarily unavailable. You can still sign in." : null }} onStart={() => router.push(loginHref(invitePath))} />;
  }

  return (
    // No height floor. min-h-screen compiles to 100vh, which in a WKWebView
    // does not shrink for chrome or safe areas, so it renders taller than the
    // visible viewport. The scroll root already fills the screen.
    <main data-location-type-scale="connect" data-location-type-context="flow" className="bg-background text-foreground">
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
              <div data-location-type-role="row-description" className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                Invitation
              </div>
              <h1 data-location-type-role="flow-title" className="ui-text-agent-title mt-1">
                Connect on One
              </h1>
              <p className="mt-3 text-[15px] font-normal leading-[20px] text-muted-foreground">
                {loading
                  ? "Checking Invite to One link."
                  : error
                    ? error
                    : claimed
                      ? "You're connected on One."
                      : <><InviterIdentity label={ownerLabel(invite)} /><span data-location-type-role="row-description" className="mt-1 block">invited you to connect.</span></>}
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

          {!loading && !invite ? (
            unavailable ? (
              <div className="space-y-3">
                <p data-location-type-role="row-description" className="text-sm text-muted-foreground">Ask the person who invited you for a new link.</p>
                <Button asChild className="min-h-11 w-full rounded-full"><Link href={ROUTES.ONE_HOME}>Open One</Link></Button>
              </div>
            ) : <Button data-location-type-role="primary-action" onClick={() => setInviteLoadAttempt((attempt) => attempt + 1)} className="min-h-11 w-full rounded-full">Try again</Button>
          ) : null}

          {!loading && invite ? (
            <div className="space-y-4">
              {invite.expiresAt ? <p data-location-type-role="row-description" className="text-[13px] text-muted-foreground">Expires {formatDateTime(invite.expiresAt)}</p> : null}

              {invite.message && !/^join me on one\.?$/i.test(invite.message.trim()) ? (
                <p data-location-type-role="row-description" className="text-[15px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                  {invite.message}
                </p>
              ) : null}

              <p data-location-type-role="row-description" className="text-[15px] leading-5 text-muted-foreground">Your location stays private until you choose to share it.</p>

              {claimError ? (
                <div data-location-type-role="row-description"
                  className={`rounded-[var(--app-card-radius-compact)] p-4 text-[15px] leading-5 ${CLAIM_FAILURE_TONE.tile} ${CLAIM_FAILURE_TONE.glyph}`}
                >
                  {claimError}
                </div>
              ) : null}

              {phoneCheckError ? (
                <div role="alert" className="space-y-2">
                  <p data-location-type-role="row-description" className="text-sm text-muted-foreground">Couldn't check your account. Please try again.</p>
                  <Button data-location-type-role="primary-action" onClick={() => setPhoneCheckAttempt((attempt) => attempt + 1)} className="min-h-11 w-full rounded-full">Try again</Button>
                </div>
              ) : auth.loading || checkingPhone ? (
                <Button data-location-type-role="primary-action" disabled className="h-11 rounded-full">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  {auth.loading ? "Checking sign in" : "Checking phone"}
                </Button>
              ) : phoneVerificationRequired ? (
                <div className="space-y-2">
                <Button asChild className="min-h-11 w-full rounded-full">
                  <Link href={buildPhoneMandateRoute(invitePath)}>
                    <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                    Accept invitation
                  </Link>
                </Button>
                <p data-location-type-role="row-description" className="text-center text-[13px] text-muted-foreground">Verify your phone to accept this invitation.</p>
                </div>
              ) : !isVaultUnlocked || !vaultOwnerToken ? (
                <div className="space-y-2">
                <Button asChild className="min-h-11 w-full rounded-full">
                  <Link href={buildProfileVaultRoute(invitePath)}>
                    <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                    Accept invitation
                  </Link>
                </Button>
                <p data-location-type-role="row-description" className="text-center text-[13px] text-muted-foreground">Unlock your private place to continue.</p>
                </div>
              ) : (
                <Button data-location-type-role="primary-action"
                  onClick={() => void handleClaim()}
                  disabled={!canClaim || claiming}
                  className="min-h-11 w-full rounded-full"
                >
                  {claiming ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {claiming ? "Accepting invitation…" : "Accept invitation"}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
