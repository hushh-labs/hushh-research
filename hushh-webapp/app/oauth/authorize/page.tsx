"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { ApiService } from "@/lib/services/api-service";

type OAuthApprovalResponse = {
  redirect_uri?: string;
  detail?: { error_description?: string };
  error_description?: string;
};

type OAuthReview = {
  client_id: string;
  client_label: string;
  redirect_host: string;
  requestRef: string;
  ownerUid: string;
};

export default function OAuthAuthorizePage() {
  const { user, loading } = useAuth();
  const searchParams = useSearchParams();
  const requestRef = String(searchParams.get("request") || "").trim();
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<OAuthReview | null>(null);
  const currentReview = review?.requestRef === requestRef && review.ownerUid === user?.uid ? review : null;

  useEffect(() => {
    if (!user || !requestRef) return;
    const controller = new AbortController();
    let active = true;
    async function loadReview() {
      try {
        const token = await user!.getIdToken();
        const response = await ApiService.apiFetch(`/api/oauth/authorize/${encodeURIComponent(requestRef)}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || typeof payload.client_id !== "string" || typeof payload.client_label !== "string" || typeof payload.redirect_host !== "string") {
          throw new Error("This authorization request could not be reviewed.");
        }
        if (active) {
          setReview({ ...payload, requestRef, ownerUid: user!.uid });
          setError(null);
        }
      } catch {
        if (active) setError("This authorization request could not be reviewed. Reconnect from your connector to try again.");
      }
    }
    void loadReview();
    return () => { active = false; controller.abort(); };
  }, [requestRef, user]);

  const complete = useCallback(
    async (decision: "approve" | "deny") => {
      if (!user || !requestRef) {
        setError("Sign in to continue with this connection.");
        return;
      }
      if (decision === "approve" && !currentReview) return;
      setSubmitting(decision);
      setError(null);
      try {
        const idToken = await user.getIdToken();
        const response = await ApiService.apiFetch(
          `/api/oauth/authorize/${encodeURIComponent(requestRef)}/${decision}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` },
            cache: "no-store",
          },
        );
        const payload = (await response.json()) as OAuthApprovalResponse;
        if (!response.ok || !payload.redirect_uri) {
          throw new Error(
            payload.error_description || payload.detail?.error_description ||
              "This authorization request is no longer available.",
          );
        }
        // The backend constructed this only from an exact registered redirect URI.
        window.location.assign(payload.redirect_uri);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not complete authorization.",
        );
        setSubmitting(null);
      }
    },
    [currentReview, requestRef, user],
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
            Authorize MCP connection
          </h1>
          <p className="text-muted-foreground">
            This signs your connector in. Any information access still requires
            a separate, scoped consent decision.
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
        {user && !currentReview && !error ? <p role="status">Checking connection details…</p> : null}
        {currentReview ? (
          <dl className="space-y-2 break-all text-sm">
            <dt className="font-medium">Requesting application</dt>
            <dd>{currentReview.client_label}</dd>
            <dt className="font-medium">Client identifier</dt>
            <dd>{currentReview.client_id}</dd>
            <dt className="font-medium">Returns to</dt>
            <dd>{currentReview.redirect_host}</dd>
          </dl>
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
            {submitting === "approve" ? "Authorizing…" : "Authorize"}
          </Button>
        </div>
      </section>
    </main>
  );
}
