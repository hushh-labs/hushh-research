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
import { buildTrustedDevicePasskeyHandoff } from "@/lib/vault/trusted-device-passkey-handoff";

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
      code_challenge_method:
        requiredParam(searchParams, "code_challenge_method") || "S256",
      device_public_key: requiredParam(searchParams, "device_public_key"),
      device_name: requiredParam(searchParams, "device_name"),
      platform: requiredParam(searchParams, "platform") || "macos",
      state: requiredParam(searchParams, "state"),
      replaces_device_id:
        requiredParam(searchParams, "replaces_device_id") || undefined,
      vault_handoff_public_key:
        requiredParam(searchParams, "vault_handoff_public_key") || undefined,
    }),
    [searchParams],
  );
  const complete = [
    request.redirect_uri,
    request.code_challenge,
    request.code_challenge_method,
    request.device_public_key,
    request.device_name,
    request.platform,
    request.state,
  ].every(Boolean);

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
      const handoffPublicKey =
        typeof payload.vault_handoff_public_key === "string"
          ? payload.vault_handoff_public_key
          : "";
      if (handoffPublicKey) {
        try {
          const handoff = await buildTrustedDevicePasskeyHandoff({
            userId: user.uid,
            deviceId: String(payload.device_id || ""),
            state: request.state,
            authorizationId: String(payload.authorization_id || ""),
            expiresAt: Number(payload.expires_at || 0),
            recipientPublicKey: handoffPublicKey,
            hostname: window.location.hostname,
            environment:
              window.location.hostname === "one.hushh.ai"
                ? "production"
                : "uat",
          });
          if (handoff) {
            const attachResponse =
              await ApiService.attachTrustedDeviceVaultHandoff(
                String(payload.authorization_id || ""),
                handoff,
              );
            if (!attachResponse.ok) {
              throw new Error("The passkey handoff could not be attached.");
            }
          }
        } catch (passkeyError) {
          // A missing, canceled, unavailable, or RP-incompatible passkey is a
          // safe fallback condition. Hermes continues with its native masked
          // passphrase prompt; no vault material was transferred.
          console.info(
            "[trusted-device] Existing passkey was not used; continuing with native enrollment.",
            passkeyError instanceof DOMException
              ? passkeyError.name
              : "unavailable",
          );
        }
      }
      assignWindowLocation(payload.redirect_url);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authorization failed.",
      );
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
        <h1 className="text-2xl font-semibold tracking-tight">
          Connect this Hermes device
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Approve this private computer as an extension of One. The vault
          passphrase remains local to Hermes and is never sent to Hussh. When
          this browser can use an existing One passkey, Touch ID can secure the
          device without asking for the passphrase again. Each signed device
          proof can issue a short-lived vault-owner capability for protected
          actions, including confirmed PKM writes.
        </p>

        <dl className="mt-6 rounded-2xl bg-muted/50 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Hussh account</dt>
            <dd className="truncate font-medium">
              {user?.email || "Sign in required"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Device</dt>
            <dd className="font-medium">
              {request.device_name || "Unknown device"}
            </dd>
          </div>
          <div className="mt-2 flex justify-between gap-4">
            <dt className="text-muted-foreground">Access</dt>
            <dd className="text-right font-medium">
              Trusted until revoked; short-lived action capabilities
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex items-start gap-3 text-sm text-muted-foreground">
          <ShieldCheck
            className="mt-0.5 size-4 shrink-0 text-emerald-600"
            aria-hidden
          />
          <p>
            You can revoke this device at any time from Profile → Security →
            Devices.
          </p>
        </div>

        {error ? (
          <p className="mt-5 text-sm text-destructive">{error}</p>
        ) : null}
        {!complete ? (
          <p className="mt-5 text-sm text-destructive">
            The Hermes authorization request is incomplete. Return to Hermes and
            try again.
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
