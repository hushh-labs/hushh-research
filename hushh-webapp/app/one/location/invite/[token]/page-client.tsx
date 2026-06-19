"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleInvite } from "@/lib/one-location/types";
import { useVault } from "@/lib/vault/vault-context";

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

function loginHref(inviteToken: string): string {
  return `/login?redirect=${encodeURIComponent(`/one/location/invite/${inviteToken}`)}`;
}

export default function OneLocationCircleInvitePageClient() {
  const router = useRouter();
  const params = useParams<{ token?: string }>();
  const auth = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const inviteToken = useMemo(
    () => String(params?.token || "").trim(),
    [params?.token],
  );
  const [invite, setInvite] = useState<OneLocationCircleInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadInvite = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await OneLocationService.resolveCircleInvite(inviteToken);
        if (!cancelled) setInvite(response.invite);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This One Location Circle invite is unavailable.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (inviteToken) {
      void loadInvite();
    } else {
      setError("This One Location Circle invite is invalid.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const handleClaim = useCallback(async () => {
    if (!auth.userId || !vaultOwnerToken) return;
    setClaiming(true);
    try {
      await bootstrapCurrentUserLocationRecipientKey({
        userId: auth.userId,
        vaultOwnerToken,
      });
      await OneLocationService.claimCircleInvite({
        vaultOwnerToken,
        inviteToken,
        message: "Joined from a One Location Circle invite.",
      });
      setClaimed(true);
      toast.success("Circle request sent for approval.");
      router.push("/one/location?section=my_requests");
    } catch (claimError) {
      toast.error(
        claimError instanceof Error
          ? claimError.message
          : "Could not join this One Location Circle.",
      );
    } finally {
      setClaiming(false);
    }
  }, [auth.userId, inviteToken, router, vaultOwnerToken]);

  const signedIn = Boolean(auth.userId && auth.isAuthenticated);
  const canClaim = signedIn && isVaultUnlocked && Boolean(vaultOwnerToken) && !claimed;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-5 py-10">
        <div className="space-y-6 rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--shadow-xs)] sm:p-7">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-700 dark:text-blue-200">
              {error ? (
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              ) : claimed ? (
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              ) : (
                <MapPin className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-300">
                One Location
              </div>
              <h1 className="mt-2 text-[28px] font-medium leading-[1.12] tracking-normal sm:text-[32px]">
                Join a private Circle
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {loading
                  ? "Checking Circle invite."
                  : error
                    ? error
                    : claimed
                      ? "Your request is waiting for owner approval."
                      : `${ownerLabel(invite)} invited you to join their One Location Circle.`}
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
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">
                  Expires {formatDateTime(invite.expiresAt)}
                </Badge>
                <Badge variant="outline">
                  {invite.durationHours}h approval window
                </Badge>
              </div>

              {invite.message ? (
                <div className="rounded-[var(--app-card-radius-standard)] border border-border/70 bg-background p-4 text-sm leading-6 text-muted-foreground">
                  {invite.message}
                </div>
              ) : null}

              <div className="rounded-[var(--app-card-radius-standard)] border border-blue-500/25 bg-blue-500/10 p-4 text-sm leading-6 text-blue-900 dark:text-blue-100">
                This invite sends a private request to the owner. Location access starts only
                after they approve it, and encrypted sharing still happens from One Location.
              </div>

              {auth.loading ? (
                <Button disabled className="h-11 rounded-full">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Checking sign in
                </Button>
              ) : !signedIn ? (
                <Button asChild className="h-11 rounded-full">
                  <Link href={loginHref(inviteToken)}>
                    <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                    Sign in to join
                  </Link>
                </Button>
              ) : !isVaultUnlocked || !vaultOwnerToken ? (
                <Button asChild className="h-11 rounded-full">
                  <Link href={`/one/location?circleInviteToken=${encodeURIComponent(inviteToken)}`}>
                    <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                    Unlock vault to join
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
                  Join Circle
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
