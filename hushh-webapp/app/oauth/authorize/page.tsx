"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { ApiService } from "@/lib/services/api-service";

type OAuthApprovalResponse = {
  redirect_uri?: string;
  detail?: { error_description?: string };
};

export default function OAuthAuthorizePage() {
  const { user, loading } = useAuth();
  const searchParams = useSearchParams();
  const requestRef = String(searchParams.get("request") || "").trim();
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const complete = useCallback(
    async (decision: "approve" | "deny") => {
      if (!user || !requestRef) {
        setError("Sign in to continue with this connection.");
        return;
      }
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
            payload.detail?.error_description ||
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
    [requestRef, user],
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
            disabled={!user || !requestRef || submitting !== null}
          >
            {submitting === "approve" ? "Authorizing…" : "Authorize"}
          </Button>
        </div>
      </section>
    </main>
  );
}
