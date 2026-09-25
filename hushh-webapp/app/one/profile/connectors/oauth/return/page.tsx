"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { useVault } from "@/lib/vault/vault-context";
import { useAuth } from "@/hooks/use-auth";
import {
  hasDrivePopupMarker,
  notifyDrivePopup,
  readDrivePopupAttempt,
} from "@/lib/profile/drive-oauth-popup";
import {
  markDriveChatRecoveryReturned,
  readDriveChatRecoveryHandoff,
} from "@/lib/agent/drive-oauth-chat-recovery";
import { Button } from "@/components/ui/button";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { saveCustomConnectorOAuthResult } from "@/lib/connections/custom-connector-configuration";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";

function DrivePopupReturn() {
  const { user, loading } = useAuth();
  const details = useRef<{
    code: string | null;
    state: string | null;
    cancelled: boolean;
  } | null>(null);
  const started = useRef(false);
  const ownerGeneration = useRef(0);
  useLayoutEffect(() => {
    const generation = ownerGeneration.current + 1;
    ownerGeneration.current = generation;
    started.current = false;
    return () => {
      ownerGeneration.current = generation + 1;
      started.current = false;
    };
  }, [user?.uid]);
  const [message, setMessage] = useState("Finishing Drive authorization…");
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!details.current) {
      const search = new URL(window.location.href).searchParams;
      details.current = {
        code: search.get("code"),
        state: search.get("state"),
        cancelled: search.has("error"),
      };
      // Do not retain provider codes/state in navigation history or outgoing referrers.
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (loading || started.current) return;
    started.current = true;
    const generation = ownerGeneration.current;
    const attempt = readDrivePopupAttempt();
    const { code, state, cancelled } = details.current;
    const finish = (outcome: "succeeded" | "failed" | "cancelled") => {
      if (ownerGeneration.current !== generation) return;
      if (attempt) notifyDrivePopup(attempt, outcome);
      details.current = null;
      setMessage(
        outcome === "succeeded"
          ? "Authorization saved. Return to chat."
          : "Authorization was not completed. Return to chat and try again.",
      );
      setFinished(true);
      window.close();
    };
    if (!attempt || !code || !state || cancelled || !user) {
      finish(cancelled ? "cancelled" : "failed");
      return;
    }
    // Firebase identity is verified against the existing vault-authorized
    // server attempt; the opener never transfers its Vault Owner token.
    void user
      .getIdToken()
      .then((idToken) => {
        if (ownerGeneration.current !== generation) return null;
        return ExternalConnectorService.completeWebOAuth({
          idToken,
          code,
          state,
          attemptId: attempt.attemptId,
        });
      })
      .then((result) => {
        if (result)
          finish(
            result.connectorId === "google_drive" &&
              ["verifying", "connected"].includes(result.status)
              ? "succeeded"
              : "failed",
          );
      })
      .catch(() => finish("failed"));
  }, [loading, user]);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
      {finished ? (
        <Button className="min-h-11" onClick={() => window.close()}>
          Close window
        </Button>
      ) : null}
    </div>
  );
}

function ConnectorOAuthReturnRouter() {
  const captured = useRef(false);
  const [popup, setPopup] = useState<boolean | null>(null);
  const [fullPageDetails, setFullPageDetails] = useState<{
    code: string | null;
    state: string | null;
    cancelled: boolean;
    attemptId: string | null;
    ownerUserId: string | null;
    issuer: string | null;
    customConnector?: { connectorId: string; revision: string };
  } | null>(null);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    const isPopup = hasDrivePopupMarker() || Boolean(window.opener);
    if (!isPopup) {
      const search = new URL(window.location.href).searchParams;
      const handoff = readDriveChatRecoveryHandoff();
      if (handoff?.reason === "web_full_page") {
        markDriveChatRecoveryReturned({
          attemptId: handoff.attemptId,
          reason: "web_full_page",
        });
      }
      setFullPageDetails({
        code: search.get("code"),
        state: search.get("state"),
        cancelled: search.has("error"),
        attemptId: handoff?.reason === "web_full_page" ? handoff.attemptId : null,
        ownerUserId: handoff?.reason === "web_full_page" ? handoff.ownerUserId ?? null : null,
        issuer: search.get("iss"),
        customConnector: handoff?.customConnector,
      });
      // A full-page return may wait for vault unlock. Keep provider codes and
      // signed state only in this mounted component, never in browser history.
      window.history.replaceState(null, "", window.location.pathname);
    }
    setPopup(isPopup);
  }, []);
  if (popup === null || (popup === false && !fullPageDetails)) return null;
  return popup ? (
    <DrivePopupReturn />
  ) : (
    <VaultLockGuard>
      {fullPageDetails?.customConnector ? <CustomConnectorOAuthReturnContent details={fullPageDetails} /> : <ConnectorOAuthReturnContent details={fullPageDetails!} />}
    </VaultLockGuard>
  );
}

function CustomConnectorOAuthReturnContent({ details }: { details: {
  code: string | null; state: string | null; cancelled: boolean;
  attemptId: string | null; ownerUserId: string | null; issuer: string | null;
  customConnector?: { connectorId: string; revision: string };
} }) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, ownerTokenStatus } = useVault();
  const router = useRouter();
  const started = useRef(false);
  const mounted = useRef(true);
  const [message, setMessage] = useState("Finishing connection…");
  const [finished, setFinished] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (started.current || ownerTokenStatus === "renewing" || !user || !vaultKey || !vaultOwnerToken) return;
    started.current = true;
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const current = () => Boolean(mounted.current && owner?.userId === user.uid &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch));
    const connector = details.customConnector;
    const controller = new AbortController();
    const run = async () => {
      if (details.ownerUserId !== user.uid || !connector || !details.attemptId || !current()) throw new Error("Invalid return.");
      if (details.cancelled) {
        await ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken, connectorId: connector.connectorId,
          operation: "cancel", payload: { attemptId: details.attemptId, revision: connector.revision },
          signal: controller.signal, isEffectCurrent: current });
        if (current()) setMessage("Sign-in cancelled. Your saved connection is unchanged.");
        return;
      }
      if (!details.code || !details.state) throw new Error("Invalid return.");
      const result = await ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken, connectorId: connector.connectorId,
        operation: "complete", payload: { attemptId: details.attemptId, revision: connector.revision,
          code: details.code, state: details.state, issuer: details.issuer }, signal: controller.signal, isEffectCurrent: current });
      const saved = await saveCustomConnectorOAuthResult({ userId: user.uid, vaultKey, vaultOwnerToken },
        connector.connectorId, connector.revision, result,
        { confirmedByUser: true, surface: "web", source: "connector_oauth_return" }, current);
      try {
        await ExternalConnectorService.refreshMcpCatalog({ vaultOwnerToken, configuration: saved,
          signal: controller.signal, isEffectCurrent: current });
        if (current()) setMessage("Sign-in saved in your vault. Tools refreshed.");
      } catch {
        if (current()) setMessage("Sign-in saved in your vault, but tools could not be refreshed. Retry Refresh tools in Chat.");
      }
    };
    void run().catch(() => { if (current()) setMessage("Could not save this connection. Return to Chat and sign in again."); })
      .finally(() => { if (current()) setFinished(true); });
  }, [details, user, vaultKey, vaultOwnerToken, ownerTokenStatus]);
  return <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
    <p role="status" className="text-sm text-muted-foreground">{message}</p>
    {finished ? <Button className="min-h-11" onClick={() => router.replace(`${ROUTES.HOME}?panel=connectors`)}>Return to Chat</Button> : null}
  </div>;
}

function ConnectorOAuthReturnContent({ details }: {
  details: {
    code: string | null;
    state: string | null;
    cancelled: boolean;
    attemptId: string | null;
    ownerUserId: string | null;
  };
}) {
  const router = useRouter();
  const { vaultOwnerToken, ownerTokenStatus } = useVault();
  const { user } = useAuth();
  const started = useRef(false);
  const [message, setMessage] = useState("Finishing connection…");

  useEffect(() => {
    if (ownerTokenStatus === "renewing" || started.current) return;
    started.current = true;

    const { code, state, cancelled } = details;

    // Connectors live in the chat sidebar's "MCP connections" panel now, not
    // a dedicated route -- landing on `?panel=connectors` is what reopens it.
    const returnHref = `${ROUTES.HOME}?panel=connectors`;

    if (cancelled) {
      setMessage("That connection was not completed.");
      globalThis.setTimeout(() => router.replace(returnHref), 1500);
      return;
    }
    if (
      !vaultOwnerToken || !code || !state ||
      (details.attemptId && (!user || details.ownerUserId !== user.uid))
    ) {
      setMessage("Missing authorization details. Please try again.");
      globalThis.setTimeout(() => router.replace(returnHref), 1500);
      return;
    }

    void (details.attemptId
      ? user!.getIdToken().then((idToken) => ExternalConnectorService.completeWebOAuth({
          idToken,
          state,
          code,
          attemptId: details.attemptId!,
        }))
      : ExternalConnectorService.completeOAuthConnect({
          vaultOwnerToken,
          state,
          code,
        }))
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
        globalThis.setTimeout(() => router.replace(returnHref), 1500);
      });
  }, [details, router, user, vaultOwnerToken, ownerTokenStatus]);

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
      <ConnectorOAuthReturnRouter />
    </Suspense>
  );
}
