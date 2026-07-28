"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Laptop, Loader2, ShieldCheck } from "lucide-react";

import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

function requiredParam(
  params: { get(name: string): string | null },
  name: string,
): string {
  return (params.get(name) || "").trim();
}

export default function TrustedDeviceAuthorizePage() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const request = useMemo(
    () => ({
      redirect_uri: requiredParam(searchParams, "redirect_uri"),
      code_challenge: requiredParam(searchParams, "code_challenge"),
      code_challenge_method: requiredParam(searchParams, "code_challenge_method") || "S256",
      device_public_key: requiredParam(searchParams, "device_public_key"),
      device_name: requiredParam(searchParams, "device_name"),
      platform: requiredParam(searchParams, "platform") || "macos",
      state: requiredParam(searchParams, "state"),
    }),
    [searchParams],
  );
  const complete = Object.values(request).every(Boolean);

  async function approve() {
    if (!user || !complete || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await ApiService.authorizeTrustedDevice(request);
      const payload = await response.json();
      if (!response.ok || typeof payload.redirect_url !== "string") {
        throw new Error(
          payload?.detail?.message || "This device could not be authorized.",
        );
      }
      assignWindowLocation(payload.redirect_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization failed.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6 py-12">
      <NativeRouteMarker
        routeId={ROUTES.PROFILE_SECURITY_DEVICE_AUTHORIZE}
        marker="native-route-profile"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <section className="w-full rounded-3xl border bg-card p-8 shadow-sm">
        <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-primary/10">
          <Laptop className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect this Hermes device</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Approve this private computer as an extension of One. The vault passphrase
          remains local to Hermes and is never sent to Hussh. Each signed device
          proof can issue a 15-minute vault-owner capability for protected actions,
          including confirmed PKM writes.
        </p>

        <dl className="mt-6 rounded-2xl bg-muted/50 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Hussh account</dt>
            <dd className="truncate font-medium">{user?.email || "Sign in required"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Device</dt>
            <dd className="font-medium">{request.device_name || "Unknown device"}</dd>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">Access</dt>
            <dd className="text-right font-medium">15-minute vault-owner capability</dd>
          </div>
        </dl>

        <div className="mt-6 flex items-start gap-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          <p>You can revoke this device at any time from Profile → Security → Devices.</p>
        </div>

        {error ? <p className="mt-5 text-sm text-destructive">{error}</p> : null}
        {!complete ? (
          <p className="mt-5 text-sm text-destructive">
            The Hermes authorization request is incomplete. Return to Hermes and try again.
          </p>
        ) : null}

        <Button
          className="mt-7 w-full"
          disabled={!user || !complete || submitting}
          onClick={() => void approve()}
        >
          {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Approve device
        </Button>
      </section>
    </main>
  );
}
