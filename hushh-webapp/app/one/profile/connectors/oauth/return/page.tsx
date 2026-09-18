"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { useVault } from "@/lib/vault/vault-context";

function ConnectorOAuthReturnContent() {
  const router = useRouter();
  const search = useSearchParams();
  const { vaultOwnerToken, ownerTokenStatus } = useVault();
  const started = useRef(false);
  const [message, setMessage] = useState("Finishing connection…");

  useEffect(() => {
    if (ownerTokenStatus === "renewing" || started.current) return;
    started.current = true;

    const code = search.get("code");
    const state = search.get("state");
    const oauthError = search.get("error") || search.get("error_description");

    if (oauthError) {
      setMessage("That connection was not completed.");
      globalThis.setTimeout(() => router.replace(ROUTES.PROFILE_CONNECTORS), 1500);
      return;
    }
    if (!vaultOwnerToken || !code || !state) {
      setMessage("Missing authorization details. Please try again.");
      globalThis.setTimeout(() => router.replace(ROUTES.PROFILE_CONNECTORS), 1500);
      return;
    }

    void ExternalConnectorService.completeOAuthConnect({
      vaultOwnerToken,
      state,
      code,
    })
      .then(() => {
        setMessage("Connected. Taking you back…");
      })
      .catch((err: unknown) => {
        setMessage(
          err instanceof Error
            ? err.message
            : "That connection could not be completed.",
        );
      })
      .finally(() => {
        globalThis.setTimeout(() => router.replace(ROUTES.PROFILE_CONNECTORS), 1500);
      });
  }, [router, search, vaultOwnerToken, ownerTokenStatus]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

export default function ConnectorOAuthReturnPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center px-6 text-center">
          <p className="text-muted-foreground text-sm">Finishing connection…</p>
        </div>
      }
    >
      <ConnectorOAuthReturnContent />
    </Suspense>
  );
}
