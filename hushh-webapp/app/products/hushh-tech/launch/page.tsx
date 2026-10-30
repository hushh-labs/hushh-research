"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { useAuth } from "@/hooks/use-auth";
import { HUSHH_TECH_LAUNCH_PATH } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

type LaunchRequest = {
  audience: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
};

type LaunchAuthorization = {
  code: string;
  expires_in: number;
  audience: string;
  redirect_uri: string;
};

type LaunchStage =
  "checking" | "authorizing" | "signed_out" | "invalid" | "error";

type LaunchAttempt = {
  key: string;
  promise: Promise<LaunchAuthorization>;
};

function readLaunchRequest(searchParams: {
  get(name: string): string | null;
}): LaunchRequest {
  return {
    audience: searchParams.get("audience") ?? "",
    redirect_uri: searchParams.get("redirect_uri") ?? "",
    state: searchParams.get("state") ?? "",
    code_challenge: searchParams.get("code_challenge") ?? "",
    code_challenge_method: searchParams.get("code_challenge_method") ?? "",
  };
}

function isCompleteLaunchRequest(request: LaunchRequest): boolean {
  return (
    request.audience.trim().length > 0 &&
    request.redirect_uri.trim().length > 0 &&
    request.state.trim().length > 0 &&
    request.code_challenge.trim().length > 0 &&
    request.code_challenge_method === "S256"
  );
}

function isLaunchAuthorization(value: unknown): value is LaunchAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LaunchAuthorization>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.trim().length > 0 &&
    typeof candidate.expires_in === "number" &&
    Number.isFinite(candidate.expires_in) &&
    candidate.expires_in > 0 &&
    typeof candidate.audience === "string" &&
    candidate.audience.trim().length > 0 &&
    typeof candidate.redirect_uri === "string" &&
    candidate.redirect_uri.trim().length > 0
  );
}

async function authorizeLaunch(
  user: { getIdToken(): Promise<string> },
  request: LaunchRequest,
): Promise<LaunchAuthorization> {
  const idToken = await user.getIdToken();
  if (!idToken.trim()) throw new Error("missing_session");

  const response = await ApiService.apiFetch(
    "/api/products/hushh-tech/launch/authorize",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      cache: "no-store",
      body: JSON.stringify({
        audience: request.audience,
        redirect_uri: request.redirect_uri,
        code_challenge: request.code_challenge,
        code_challenge_method: request.code_challenge_method,
      }),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isLaunchAuthorization(payload)) {
    throw new Error("authorization_failed");
  }
  if (
    payload.audience !== request.audience ||
    payload.redirect_uri !== request.redirect_uri
  ) {
    throw new Error("launch_binding_mismatch");
  }
  return payload;
}

function buildCallbackUrl(
  authorization: LaunchAuthorization,
  state: string,
): string {
  const target = new URL(authorization.redirect_uri);
  if (
    target.protocol !== "https:" ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new Error("invalid_redirect");
  }
  target.searchParams.set("code", authorization.code);
  target.searchParams.set("state", state);
  target.searchParams.set("source", "hushh-research");
  return target.toString();
}

function LaunchFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <section className="w-full max-w-sm text-center">{children}</section>
    </main>
  );
}

function LaunchFallback() {
  useSessionChromeSuppression(true);
  return (
    <LaunchFrame>
      <p role="status">Checking sign-in…</p>
    </LaunchFrame>
  );
}

function HushhTechLaunchContent() {
  useSessionChromeSuppression(true);
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const [stage, setStage] = useState<LaunchStage>("checking");
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptRef = useRef<LaunchAttempt | null>(null);
  const request = useMemo(
    () => readLaunchRequest(searchParams),
    [searchParams],
  );
  const returnTo = useMemo(() => {
    const query = searchParams.toString();
    return query
      ? `${HUSHH_TECH_LAUNCH_PATH}?${query}`
      : HUSHH_TECH_LAUNCH_PATH;
  }, [searchParams]);

  useEffect(() => {
    if (!isCompleteLaunchRequest(request)) {
      setStage("invalid");
      return;
    }
    if (loading) {
      setStage("checking");
      return;
    }
    if (!user) {
      setStage("signed_out");
      return;
    }

    setStage("authorizing");
    const attemptKey = [
      user.uid,
      request.audience,
      request.redirect_uri,
      request.state,
      request.code_challenge,
      request.code_challenge_method,
      retryNonce,
    ].join("\u0000");
    let attempt = attemptRef.current;
    if (!attempt || attempt.key !== attemptKey) {
      attempt = {
        key: attemptKey,
        promise: authorizeLaunch(user, request),
      };
      attemptRef.current = attempt;
    }

    let active = true;
    void attempt.promise
      .then((authorization) => {
        if (!active) return;
        assignWindowLocation(buildCallbackUrl(authorization, request.state));
      })
      .catch(() => {
        if (!active) return;
        setStage("error");
      });

    return () => {
      active = false;
    };
  }, [loading, request, retryNonce, user]);

  if (stage === "invalid") {
    return (
      <LaunchFrame>
        <h1 className="text-2xl font-semibold">Link not valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open Hushh Tech again.
        </p>
      </LaunchFrame>
    );
  }

  if (stage === "signed_out") {
    return (
      <LaunchFrame>
        <h1 className="text-2xl font-semibold">Sign in to continue</h1>
        <Button asChild className="mt-6">
          <Link href={`/login?redirect=${encodeURIComponent(returnTo)}`}>
            Sign in
          </Link>
        </Button>
      </LaunchFrame>
    );
  }

  if (stage === "error") {
    return (
      <LaunchFrame>
        <h1 className="text-2xl font-semibold">Couldn’t continue</h1>
        <Button
          className="mt-6"
          onClick={() => {
            attemptRef.current = null;
            setRetryNonce((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </LaunchFrame>
    );
  }

  return (
    <LaunchFrame>
      <p role="status">
        {stage === "authorizing" ? "Opening Hushh Tech…" : "Checking sign-in…"}
      </p>
    </LaunchFrame>
  );
}

export default function HushhTechLaunchPage() {
  return (
    <Suspense fallback={<LaunchFallback />}>
      <HushhTechLaunchContent />
    </Suspense>
  );
}
