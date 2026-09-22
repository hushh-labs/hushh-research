"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Capacitor } from "@capacitor/core";
import { ArrowLeftIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { HushhAuth } from "@/lib/capacitor";
import {
  NATIVE_CONNECTOR_RETURN_EVENT,
  type NativeConnectorReturn,
} from "@/lib/navigation/use-deep-link-return";
import { ROUTES } from "@/lib/navigation/routes";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  createGmailOAuthPopupAttempt,
  openGmailOAuthPopup,
  navigateGmailOAuthPopup,
  isGmailOAuthPopupSettlement,
  readGmailOAuthPopupSettlementFallback,
  clearGmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";
import {
  openDriveOAuthPopup,
  navigateDriveOAuthPopup,
  waitForDrivePopup,
  waitForOAuthPopup,
} from "@/lib/profile/drive-oauth-popup";
import {
  ExternalConnectorService,
  type ConnectorOverview,
  type DriveDocument,
} from "@/lib/services/external-connector-service";
import {
  GoogleDrivePickerService,
  type PickedDriveFile,
} from "@/lib/services/google-drive-picker-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

type Props = {
  open: boolean;
  onBack: () => void;
  onAvailableChange: (available: boolean) => void;
  onExternalModalChange: (open: boolean) => void;
};
const touch = "min-h-11 min-w-11 whitespace-normal";
const labels: Record<string, string> = {
  not_connected: "Not connected",
  revoked: "Not connected",
  connected: "Connected",
  verifying: "Authorized · choose files to verify",
  needs_reauth: "Reconnect needed",
  error: "Connection unavailable",
  queued: "Waiting to process",
  fetching: "Reading",
  parsing: "Processing",
  indexing: "Indexing",
  ready: "Ready",
  stale: "Update needed",
  unsupported: "Unsupported format",
  failed_retryable: "Retry needed",
};

export function ConnectorsPanel(props: Props) {
  const { user } = useAuth();
  // Discard all local state on account switch or lock; don't display the prior
  // owner's account labels, pending selection or status on the new session.
  const { vaultOwnerToken } = useVault();
  return (
    <OwnerConnectorsPanel
      key={`${user?.uid ?? "signed-out"}:${Boolean(vaultOwnerToken)}`}
      {...props}
    />
  );
}

function OwnerConnectorsPanel({
  open,
  onBack,
  onAvailableChange,
  onExternalModalChange,
}: Props) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [overview, setOverview] = useState<ConnectorOverview | null>(null);
  const [documents, setDocuments] = useState<DriveDocument[]>([]);
  const [allowBackground, setAllowBackground] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [driveMessage, setDriveMessage] = useState("");
  const [mailMessage, setMailMessage] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [pending, setPending] = useState<{
    sessionId: string;
    expiresAt: number;
    files: PickedDriveFile[];
  } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const currentToken = useRef(vaultOwnerToken);
  useLayoutEffect(() => {
    currentToken.current = vaultOwnerToken;
  }, [vaultOwnerToken]);
  const driveLock = useRef(false);
  // Native browser returns and Vault Owner token renewal can overlap the
  // existing Drive mutation. Keep only opaque attempt metadata in memory and
  // drain it after that mutation releases the single-flight lock.
  const queuedNativeReconcile = useRef<{
    expectedAttemptId?: string;
  } | null>(null);
  const drainNativeReconcile = useRef<() => void>(() => undefined);
  const mailLock = useRef(false);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<HTMLElement>(null);
  const restorePickerFocus = useRef(false);
  const overviewRead = useRef(0);
  const documentRead = useRef(0);
  const mailToken = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );
  const gmail = useGmailConnectorStatus({
    userId: user?.uid,
    enabled: open,
    idTokenProvider: user ? mailToken : null,
    routeHref: ROUTES.HOME,
  });
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const token = currentToken.current;
    if (!token) return false;
    const request = ++overviewRead.current;
    setStatusChecked(false);
    setLoading(true);
    try {
      const result = await ExternalConnectorService.overview(token);
      if (
        signal?.aborted ||
        currentToken.current !== token ||
        request !== overviewRead.current
      )
        return false;
      setOverview(result);
      setStatusChecked(true);
      return true;
    } catch {
      if (
        !signal?.aborted &&
        currentToken.current === token &&
        request === overviewRead.current
      )
        setDriveMessage(
          "Could not check Drive. Retry before starting another connection.",
        );
      return false;
    } finally {
      if (
        !signal?.aborted &&
        currentToken.current === token &&
        request === overviewRead.current
      )
        setLoading(false);
    }
  }, []);
  const refreshDocuments = useCallback(async (signal: AbortSignal) => {
    const token = currentToken.current;
    if (!token) return;
    const request = ++documentRead.current;
    const next = await ExternalConnectorService.documents(token);
    if (
      !signal.aborted &&
      currentToken.current === token &&
      request === documentRead.current
    )
      setDocuments(next);
  }, []);
  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    return () => {
      lifetime.abort();
      onExternalModalChange(false);
    };
  }, [onExternalModalChange]);
  useEffect(() => {
    if (vaultOwnerToken) void refresh(controller.current?.signal);
  }, [vaultOwnerToken, refresh]);
  const drive = overview?.connectors.find(
    (item) => item.connectorId === "google_drive",
  );
  const hasDriveGrant = Boolean(
    drive && !["not_connected", "revoked"].includes(drive.status),
  );
  useEffect(() => {
    onAvailableChange(
      Boolean(
        vaultOwnerToken &&
        (overview?.features.connections_panel_v2 === true || hasDriveGrant),
      ),
    );
  }, [
    vaultOwnerToken,
    overview?.features.connections_panel_v2,
    hasDriveGrant,
    onAvailableChange,
  ]);
  useEffect(() => {
    const signal = controller.current?.signal;
    if (open && hasDriveGrant && signal)
      void refreshDocuments(signal).catch(() => {
        if (!signal.aborted)
          setDriveMessage("Could not load selected files. Try again.");
      });
  }, [open, hasDriveGrant, refreshDocuments]);
  useEffect(() => {
    if (!pending) return;
    setAllowBackground(false);
    const timer = window.setTimeout(
      () => {
        setPending(null);
        setDriveMessage("Selection expired. Choose files again.");
      },
      Math.max(0, pending.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (driveBusy || !restorePickerFocus.current) return;
    restorePickerFocus.current = false;
    const frame = requestAnimationFrame(() => {
      (
        pendingRef.current?.querySelector<HTMLButtonElement>("button") ??
        chooseRef.current
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [driveBusy, pending]);

  const runDrive = useCallback(
    async (
      action: (token: string, signal: AbortSignal) => Promise<void>,
      options: { clearMessage?: boolean } = {},
    ) => {
      const token = vaultOwnerToken;
      const signal = controller.current?.signal;
      if (!token || !signal || signal.aborted || driveLock.current) return;
      // Retire reads taken before this operation. Late GETs cannot resurrect
      // removed documents or a connection which has just been disconnected.
      overviewRead.current++;
      documentRead.current++;
      driveLock.current = true;
      setDriveBusy(true);
      if (options.clearMessage !== false) setDriveMessage("");
      try {
        await action(token, signal);
      } catch {
        if (!signal.aborted)
          setDriveMessage(
            "Drive could not finish this action. Check the connection and try again.",
          );
      } finally {
        driveLock.current = false;
        if (queuedNativeReconcile.current)
          queueMicrotask(() => drainNativeReconcile.current());
        if (!signal.aborted) {
          setDriveBusy(false);
          setLoading(false);
        }
      }
    },
    [vaultOwnerToken],
  );

  const finalizeNativeDrive = useCallback(
    async (
      token: string,
      signal: AbortSignal,
      expectedAttemptId?: string,
    ): Promise<boolean> => {
      const isEffectCurrent = () =>
        !signal.aborted && currentToken.current === token;
      const pending = await ExternalConnectorService.pendingNative({
        vaultOwnerToken: token,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return false;
      if (
        !pending ||
        (expectedAttemptId && pending.attemptId !== expectedAttemptId)
      ) {
        // A recovery poll itself is a Drive operation and retires any older
        // overview read. Restore the authoritative connection status even
        // when there was no staged credential to finalize.
        await refresh(signal);
        return false;
      }
      await ExternalConnectorService.finalizeNative({
        vaultOwnerToken: token,
        attemptId: pending.attemptId,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return false;
      return await refresh(signal);
    },
    [refresh],
  );

  const drainQueuedNativeReconcile = useCallback(() => {
    if (
      !open ||
      !vaultOwnerToken ||
      !Capacitor.isNativePlatform() ||
      driveLock.current
    )
      return;
    const queued = queuedNativeReconcile.current;
    if (!queued) return;
    queuedNativeReconcile.current = null;
    void runDrive(
      async (token, signal) => {
        const finalized = await finalizeNativeDrive(
          token,
          signal,
          queued.expectedAttemptId,
        );
        if (finalized && !signal.aborted)
          setDriveMessage(
            "Drive connected. Choose files from a browser to authorize them.",
          );
      },
      { clearMessage: false },
    );
  }, [finalizeNativeDrive, open, runDrive, vaultOwnerToken]);

  useLayoutEffect(() => {
    drainNativeReconcile.current = drainQueuedNativeReconcile;
    return () => {
      drainNativeReconcile.current = () => undefined;
    };
  }, [drainQueuedNativeReconcile]);

  const queueNativeReconcile = useCallback(
    (expectedAttemptId?: string) => {
      const queued = queuedNativeReconcile.current;
      // A completed callback is more specific than startup recovery. Never
      // replace a callback attempt with a generic poll while it is queued.
      if (!queued || expectedAttemptId)
        queuedNativeReconcile.current = { expectedAttemptId };
      drainQueuedNativeReconcile();
    },
    [drainQueuedNativeReconcile],
  );

  const startDrive = () => {
    if (!vaultOwnerToken || driveLock.current) return;
    if (Capacitor.isNativePlatform()) {
      void runDrive(async (token, signal) => {
        const isEffectCurrent = () =>
          !signal.aborted && currentToken.current === token;
        if (!user?.uid) throw new Error("native_owner_unavailable");
        const start = await ExternalConnectorService.startOAuthConnect({
          vaultOwnerToken: token,
          connectorId: "google_drive",
          redirectUri: ExternalConnectorService.nativeDriveOAuthCallbackUri(),
          flow: "native",
          isEffectCurrent,
        });
        const expiresAt = Date.parse(start.expiresAt);
        if (
          !isEffectCurrent() ||
          !start.attemptId ||
          start.connectorId !== "google_drive" ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        ) {
          throw new Error("invalid_start");
        }
        const result = await HushhAuth.connectDrive({
          authorizeUrl: start.authorizeUrl,
          attemptId: start.attemptId,
          expiresAt,
          expectedUserId: user.uid,
        });
        if (!isEffectCurrent()) return;
        if (result.attemptId !== start.attemptId) {
          // A stale custom-scheme return must not terminate a newer native
          // operation. The exact current attempt remains recoverable through
          // the owner-only pending endpoint after this lock releases.
          queueNativeReconcile(start.attemptId);
          setDriveMessage("Drive could not finish connecting. Try again.");
          return;
        }
        if (result.outcome !== "ready") {
          // Older Android browsers can deliver their Custom Tabs return just
          // after RESULT_CANCELED. Reconcile the exact attempt after the
          // native operation releases its lock before treating it as terminal.
          queueNativeReconcile(start.attemptId);
          await refresh(signal);
          if (!signal.aborted) {
            setDriveMessage(
              result.outcome === "cancelled"
                ? "Drive connection was cancelled. Your chat and draft stay here."
                : "Drive could not finish connecting. Try again.",
            );
          }
          return;
        }
        const finalized = await finalizeNativeDrive(
          token,
          signal,
          start.attemptId,
        );
        if (!signal.aborted) {
          setDriveMessage(
            finalized
              ? "Drive connected. Choose files from a browser to authorize them."
              : "Drive authorization is still settling. Reopen Connections to check it.",
          );
        }
      });
      return;
    }
    const popup = openDriveOAuthPopup();
    if (!popup) {
      setDriveMessage(
        "Allow popups, then retry. Your chat and draft stay here.",
      );
      return;
    }
    void runDrive(async (token, signal) => {
      const close = () => popup.close();
      signal.addEventListener("abort", close, { once: true });
      try {
        const start = await ExternalConnectorService.startOAuthConnect({
          vaultOwnerToken: token,
          connectorId: "google_drive",
          redirectUri: `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`,
          flow: "web",
        });
        if (signal.aborted) return;
        if (!start.attemptId || start.connectorId !== "google_drive")
          throw new Error("invalid_start");
        const attempt = {
          connectorId: "google_drive" as const,
          attemptId: start.attemptId,
          expiresAt: Date.parse(start.expiresAt),
        };
        navigateDriveOAuthPopup(popup, attempt, start.authorizeUrl);
        await waitForDrivePopup(popup, attempt, signal);
        if (!signal.aborted && (await refresh(signal)))
          setDriveMessage(
            "Connection checked. Choose files if authorized, or retry Connect.",
          );
      } finally {
        signal.removeEventListener("abort", close);
        popup.close();
      }
    });
  };
  useEffect(() => {
    if (!open || !vaultOwnerToken || !Capacitor.isNativePlatform()) return;
    const handleReturn = (event: Event) => {
      const result = (event as CustomEvent<NativeConnectorReturn>).detail;
      if (!result) return;
      if (result.outcome === "ready") queueNativeReconcile(result.attemptId);
      else if (result.outcome === "cancelled")
        setDriveMessage(
          "Drive connection was cancelled. Your chat and draft stay here.",
        );
      else setDriveMessage("Drive could not finish connecting. Try again.");
    };
    window.addEventListener(NATIVE_CONNECTOR_RETURN_EVENT, handleReturn);
    queueNativeReconcile();
    return () =>
      window.removeEventListener(NATIVE_CONNECTOR_RETURN_EVENT, handleReturn);
  }, [open, queueNativeReconcile, vaultOwnerToken]);
  const chooseFiles = () =>
    void runDrive(async (token, signal) => {
      const session = await ExternalConnectorService.pickerSession(
        token,
        window.location.origin,
      );
      if (signal.aborted) {
        session.accessToken = "";
        return;
      }
      onExternalModalChange(true);
      try {
        const files = await GoogleDrivePickerService.choose(session, signal);
        if (!signal.aborted && files.length)
          setPending({
            sessionId: session.sessionId,
            expiresAt: Date.parse(session.expiresAt),
            files,
          });
      } finally {
        session.accessToken = "";
        if (!signal.aborted) {
          onExternalModalChange(false);
          restorePickerFocus.current = true;
          await refresh(signal);
        }
      }
    });
  const connectMail = () => {
    const signal = controller.current?.signal;
    if (!user || !signal || signal.aborted || mailLock.current) return;
    const native = Capacitor.isNativePlatform();
    const attempt = createGmailOAuthPopupAttempt();
    const popup = native ? null : openGmailOAuthPopup(attempt);
    if (!native && !popup) {
      setMailMessage(
        "Allow popups, then retry. Your chat and draft stay here.",
      );
      return;
    }
    mailLock.current = true;
    setMailBusy(true);
    setMailMessage("");
    const close = () => popup?.close();
    signal.addEventListener("abort", close, { once: true });
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (signal.aborted) return;
        if (native) {
          const start = await GmailReceiptsService.startNativeConnect({
            idToken,
            purpose: "read",
          });
          if (signal.aborted || !start.configured) return;
          const result = await HushhAuth.connectGmail({
            serverClientId: start.server_client_id,
            purpose: start.purpose,
          });
          if (signal.aborted) return;
          await GmailReceiptsService.completeNativeConnect({
            idToken,
            userId: user.uid,
            serverAuthCode: result.serverAuthCode,
          });
        } else if (popup) {
          const start = await GmailReceiptsService.startConnect({
            idToken,
            userId: user.uid,
            includeGrantedScopes: false,
            purpose: "read",
          });
          if (signal.aborted) return;
          const url = new URL(start.authorize_url);
          if (
            !start.configured ||
            url.origin !== "https://accounts.google.com" ||
            url.pathname !== "/o/oauth2/v2/auth"
          )
            throw new Error("invalid_start");
          navigateGmailOAuthPopup(popup, start.authorize_url);
          await waitForOAuthPopup({
            popup,
            signal,
            expiresAt: Math.min(
              Date.parse(start.expires_at),
              attempt.startedAt + 10 * 60_000,
            ),
            matches: (value) =>
              isGmailOAuthPopupSettlement(value) &&
              value.attemptId === attempt.attemptId,
            storageValue: readGmailOAuthPopupSettlementFallback,
          });
        }
        if (!signal.aborted) {
          const status = await gmail.refreshStatus({
            force: true,
            reconcile: false,
          });
          if (!signal.aborted)
            setMailMessage(
              status?.connected
                ? "Mail connected."
                : "Mail is not connected yet. You can retry.",
            );
        }
      } catch {
        if (!signal.aborted)
          setMailMessage("Could not finish Mail connection. Try again.");
      } finally {
        signal.removeEventListener("abort", close);
        popup?.close();
        clearGmailOAuthPopupAttempt();
        mailLock.current = false;
        if (!signal.aborted) setMailBusy(false);
      }
    })();
  };

  const canConnectDrive =
    statusChecked &&
    drive?.available !== false &&
    overview?.features.google_drive_connection === true;
  const canPick =
    drive?.available !== false &&
    !Capacitor.isNativePlatform() &&
    overview?.features.google_drive_picker === true &&
    ["connected", "verifying"].includes(drive?.status ?? "");
  const confirmAction = () => {
    const target = confirm;
    setConfirm(null);
    setPending(null);
    if (target === "mail") {
      const signal = controller.current?.signal;
      if (mailLock.current || !signal || signal.aborted) return;
      mailLock.current = true;
      setMailBusy(true);
      void gmail
        .disconnectGmail()
        .then(() => {
          if (!signal.aborted)
            setMailMessage("Mail disconnected. Drive is unchanged.");
        })
        .catch(() => {
          if (!signal.aborted)
            setMailMessage("Could not disconnect Mail. Check and retry.");
        })
        .finally(() => {
          mailLock.current = false;
          if (!signal.aborted) setMailBusy(false);
        });
    } else if (target)
      void runDrive(async (token, signal) => {
        if (target === "drive") {
          const result = await ExternalConnectorService.disconnect({
            vaultOwnerToken: token,
            connectorId: "google_drive",
          });
          if (signal.aborted) return;
          setDocuments([]);
          setDriveMessage(
            result.revocationOutcome === "revoked"
              ? "Drive disconnected. Mail is unchanged."
              : "Drive is disabled in One. Google revocation was not confirmed; remove access in your Google account if needed.",
          );
        } else await ExternalConnectorService.removeDocument(token, target);
        if (!signal.aborted) {
          await refresh(signal);
          await refreshDocuments(signal);
        }
      });
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col rounded-r-2xl border-r border-border bg-background"
      data-connections-panel
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <Button
          variant="ghost"
          className={touch}
          onClick={onBack}
          aria-label="Back to Chats"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
        </Button>
        <h2 className="text-base font-semibold">Connections</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {!vaultOwnerToken ? (
          <p role="status" className="text-sm text-muted-foreground">
            Unlock your vault to manage connections.
          </p>
        ) : (
          <>
            <section
              aria-labelledby="connection-mail-title"
              className="space-y-3 rounded-xl border border-border p-3"
            >
              <h3 id="connection-mail-title" className="font-semibold">
                Mail
              </h3>
              <p className="break-all text-sm text-muted-foreground">
                {gmail.status?.google_email || "Gmail"}
              </p>
              <p role="status" className="text-sm">
                {gmail.loadingStatus
                  ? "Checking Mail…"
                  : gmail.statusError
                    ? "Status unavailable"
                    : gmail.status?.needs_reauth
                      ? "Reconnect needed"
                      : gmail.status?.connected
                        ? "Connected"
                        : "Not connected"}
              </p>
              <div className="flex flex-wrap gap-2">
                {(!gmail.status?.connected || gmail.status?.needs_reauth) && (
                  <Button
                    className={touch}
                    disabled={mailBusy || gmail.loadingStatus}
                    onClick={connectMail}
                  >
                    {gmail.status?.needs_reauth
                      ? "Reconnect Mail"
                      : "Connect Mail"}
                  </Button>
                )}
                {(gmail.status?.connected || gmail.status?.needs_reauth) && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={mailBusy}
                    onClick={() => setConfirm("mail")}
                  >
                    Disconnect Mail
                  </Button>
                )}
                {gmail.statusError && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={mailBusy}
                    onClick={() =>
                      void gmail.refreshStatus({
                        force: true,
                        reconcile: false,
                      })
                    }
                  >
                    Retry Mail
                  </Button>
                )}
              </div>
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {mailBusy ? "Updating Mail…" : mailMessage}
              </p>
            </section>
            <section
              aria-labelledby="connection-drive-title"
              className="space-y-3 rounded-xl border border-border p-3"
            >
              <h3 id="connection-drive-title" className="font-semibold">
                Drive
              </h3>
              <p className="break-all text-sm text-muted-foreground">
                {drive?.accountLabel || "Only files you choose"}
              </p>
              <p role="status" className="text-sm">
                {loading
                  ? "Checking Drive…"
                  : drive
                    ? (labels[drive.status] ?? "Status unavailable")
                    : "Not connected"}
              </p>
              <div className="flex flex-wrap gap-2">
                {(!hasDriveGrant ||
                  drive?.status === "needs_reauth" ||
                  drive?.status === "error") && (
                  <Button
                    className={touch}
                    disabled={driveBusy || loading || !canConnectDrive}
                    onClick={startDrive}
                  >
                    {hasDriveGrant ? "Reconnect Drive" : "Connect Drive"}
                  </Button>
                )}
                {hasDriveGrant && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={driveBusy}
                    onClick={() => setConfirm("drive")}
                  >
                    Disconnect Drive
                  </Button>
                )}
                {canPick && (
                  <Button
                    ref={chooseRef}
                    className={touch}
                    disabled={driveBusy || Boolean(pending)}
                    onClick={chooseFiles}
                  >
                    Choose files
                  </Button>
                )}
                <Button
                  className={touch}
                  variant="ghost"
                  disabled={driveBusy || loading}
                  onClick={() => {
                    void refresh(controller.current?.signal);
                    if (controller.current)
                      void refreshDocuments(controller.current.signal).catch(
                        () => undefined,
                      );
                  }}
                >
                  Retry Drive
                </Button>
              </div>
              {!canConnectDrive && (
                <p className="text-sm text-muted-foreground">
                  New Drive connections are not available here yet.
                </p>
              )}
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {driveBusy ? "Updating Drive…" : driveMessage}
              </p>
              {pending && (
                <section
                  ref={pendingRef}
                  className="space-y-3 rounded-lg border border-border p-3"
                  aria-label="Confirm selected files"
                >
                  <p className="text-sm">
                    Add these files to your private One library? Google access
                    is not the same as sharing with another person.
                  </p>
                  <ul className="space-y-2 text-sm">
                    {pending.files.map((file) => (
                      <li key={file.id} className="break-all">
                        {file.name}
                      </li>
                    ))}
                  </ul>
                  {overview?.features.drive_document_indexing && (
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 size-5 shrink-0"
                        checked={allowBackground}
                        disabled={driveBusy}
                        onChange={(event) =>
                          setAllowBackground(event.target.checked)
                        }
                      />
                      <span>
                        Allow One to process these files while Hushh is closed
                        and prepare suggestions for requests. Sharing still
                        needs your approval.
                      </span>
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className={touch}
                      disabled={driveBusy}
                      onClick={() =>
                        void runDrive(async (token, signal) => {
                          await ExternalConnectorService.selectDocuments(
                            token,
                            pending.sessionId,
                            pending.files.map((file) => file.id),
                            allowBackground,
                          );
                          if (!signal.aborted) {
                            setPending(null);
                            await refreshDocuments(signal);
                          }
                        })
                      }
                    >
                      Add selected files
                    </Button>
                    <Button
                      className={touch}
                      variant="outline"
                      disabled={driveBusy}
                      onClick={() => setPending(null)}
                    >
                      Cancel selection
                    </Button>
                  </div>
                </section>
              )}
              {documents.length > 0 && (
                <ul className="space-y-3" aria-label="Selected Drive files">
                  {documents.map((item) => (
                    <li
                      key={item.documentId}
                      className="space-y-1 border-t border-border pt-3"
                    >
                      <p className="break-all text-sm">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {!item.backgroundProcessing && item.status === "queued"
                          ? "Background processing is off"
                          : (labels[item.status] ?? "Status unavailable")}
                      </p>
                      {(overview?.features.drive_document_indexing ||
                        item.backgroundProcessing) && (
                        <label className="flex min-h-11 items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1 size-5 shrink-0"
                            checked={item.backgroundProcessing === true}
                            aria-label={`Background processing for ${item.name}`}
                            disabled={driveBusy}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              void runDrive(async (token, signal) => {
                                await ExternalConnectorService.setDocumentProcessing(
                                  token,
                                  item.documentId,
                                  enabled,
                                );
                                await refreshDocuments(signal);
                              });
                            }}
                          />
                          <span>
                            Process this file while Hushh is closed. Prepare
                            suggestions, never share without approval. Turning
                            this off keeps the existing private index.
                          </span>
                        </label>
                      )}
                      {item.backgroundProcessing &&
                        overview?.features.drive_document_indexing && (
                          <Button
                            variant="ghost"
                            className={touch}
                            aria-label={`Sync ${item.name} now`}
                            disabled={driveBusy}
                            onClick={() =>
                              void runDrive(async (token, signal) => {
                                await ExternalConnectorService.syncDocument(
                                  token,
                                  item.documentId,
                                );
                                await refreshDocuments(signal);
                              })
                            }
                          >
                            Sync now
                          </Button>
                        )}
                      <Button
                        variant="ghost"
                        className={touch}
                        disabled={driveBusy}
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setConfirm(item.documentId)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {confirm && (
              <section
                className="space-y-3 rounded-xl border border-border p-3"
                aria-label="Confirm connection change"
              >
                <p className="text-sm">
                  {confirm === "mail"
                    ? "Disconnect Mail? Drive stays connected."
                    : confirm === "drive"
                      ? "Disconnect Drive and remove its selected files from One? Existing Google sharing stays active until you revoke it. Mail stays connected."
                      : "Remove this file from One? The original in Google Drive is unchanged."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className={touch}
                    disabled={mailBusy || driveBusy}
                    onClick={confirmAction}
                  >
                    Confirm
                  </Button>
                  <Button
                    className={touch}
                    variant="outline"
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
