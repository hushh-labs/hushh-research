"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { ConsumerMemoryApproval } from "@/components/developers/consumer-memory-approval";
import { Button } from "@/lib/morphy-ux/button";
import { ApiService } from "@/lib/services/api-service";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

type OAuthApprovalResponse = {
  redirect_uri?: string;
  detail?: { error_description?: string };
};

type ConnectionReview = {
  userId: string;
  requestRef: string;
  clientName: string;
};

export default function OAuthAuthorizePage() {
  const params = useSearchParams();
  if (params.has("consumer")) {
    return <ConsumerMemoryApproval connectionId={params.get("consumer") || ""} authorizationId={params.get("authorization") || ""} />;
  }
  return <OAuthConnectionApproval />;
}

function OAuthConnectionApproval() {
  const { user, loading } = useAuth();
  const searchParams = useSearchParams();
  const requestRef = String(searchParams.get("request") || "").trim();
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ConnectionReview | null>(null);
  const reviewController = useRef<AbortController | null>(null);
  const currentReview =
    review?.userId === user?.uid && review?.requestRef === requestRef ? review : null;

  // Cancel the previous approval at commit, before delayed responses can act on a new screen.
  useLayoutEffect(() => {
    if (!user || !requestRef) return;
    const signedInUser = user;
    let active = true;
    const controller = new AbortController();
    reviewController.current = controller;
    setReview(null);
    setError(null);
    setSubmitting(null);
    async function loadReview() {
      try {
        const idToken = await signedInUser.getIdToken();
        if (!active) return;
        const response = await ApiService.apiFetch(
          `/api/oauth/authorize/${encodeURIComponent(requestRef)}`,
          { headers: { Authorization: `Bearer ${idToken}` }, cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json();
        if (!response.ok || typeof payload.client_name !== "string" || !payload.client_name || payload.memory_access_granted !== false) {
          throw new Error("This connection request is unavailable. Return to your assistant and reconnect.");
        }
        if (active) setReview({ userId: signedInUser.uid, requestRef, clientName: payload.client_name });
      } catch {
        if (active) setError("Could not load this connection. Return to your assistant and reconnect.");
      }
    }
    void loadReview();
    return () => { active = false; controller.abort(); };
  }, [user, requestRef]);

  const complete = useCallback(
    async (decision: "approve" | "deny") => {
      if (!user || !requestRef || (decision === "approve" && !currentReview)) {
        setError("Sign in to continue with this connection.");
        return;
      }
      const owner = snapshotValidatedAuthSessionOwner();
      const controller = reviewController.current;
      if (!owner || owner.userId !== user.uid || !controller || controller.signal.aborted) return;
      const isCurrent = () => !controller.signal.aborted && isValidatedAuthSessionOwnerCurrent(owner);
      setSubmitting(decision);
      setError(null);
      try {
        const idToken = await user.getIdToken();
        if (!isCurrent()) return;
        const response = await ApiService.apiFetch(
          `/api/oauth/authorize/${encodeURIComponent(requestRef)}/${decision}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!isCurrent()) return;
        const payload = (await response.json()) as OAuthApprovalResponse;
        if (!isCurrent()) return;
        if (!response.ok || !payload.redirect_uri) {
          throw new Error(
            payload.detail?.error_description ||
              "This authorization request is no longer available.",
          );
        }
        // The backend constructed this only from an exact registered redirect URI.
        window.location.assign(payload.redirect_uri);
      } catch (caught) {
        if (!isCurrent()) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not complete authorization.",
        );
        setSubmitting(null);
      }
    },
    [requestRef, user, currentReview],
  );

  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg items-start justify-center px-6 pt-[18vh]">
        Checking sign-in…
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg items-start px-6 pt-[12vh]">
      <section className="w-full space-y-5">
        <p className="text-sm font-medium text-primary">Hussh Consent</p>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {currentReview ? `Connect ${currentReview.clientName}` : "Connect your assistant"}
          </h1>
          <p className="text-muted-foreground">
            Connect this assistant to Hussh. You’ll choose what it can access separately.
          </p>
        </div>
        {!user ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Sign in to One to review this connection. Your authorization
              request will be preserved.
            </p>
            <Button asChild>
              <Link
                href={`/login?redirect=${encodeURIComponent(
                  `/oauth/authorize?request=${encodeURIComponent(requestRef)}`,
                )}`}
              >
                Sign in to continue
              </Link>
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex gap-3">
          <Button
            variant="none"
            effect="glass"
            onClick={() => complete("deny")}
            disabled={!user || !requestRef || submitting !== null}
          >
            Cancel
          </Button>
          <Button
            onClick={() => complete("approve")}
            disabled={!user || !requestRef || !currentReview || submitting !== null}
          >
            {submitting === "approve" ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </section>
    </main>
  );
}
