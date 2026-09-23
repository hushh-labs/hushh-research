"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Capacitor } from "@capacitor/core";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { HushhAuth } from "@/lib/capacitor";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  createGoogleOAuthPopupAttempt,
  openGoogleOAuthPopup,
  navigateGoogleOAuthPopup,
} from "@/lib/google/google-oauth-popup";
import {
  GoogleOAuthPopupWaitError,
  waitForGoogleOAuthPopup,
} from "@/lib/google/google-oauth-popup-wait";
import {
  GoogleDriveService,
  captureDriveConnectionContext,
  isDriveConnectionCurrent,
} from "@/lib/services/google-drive-service";

type DriveUser = { uid: string; getIdToken: () => Promise<string> };
class DriveConnectionNotice extends Error {}

export function DriveConnectorCard({
  user,
  enabled,
  onUnlock,
}: {
  user: DriveUser | null;
  enabled: boolean;
  onUnlock: () => void;
}) {
  return (
    <Card className="mb-3">
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
        <CardDescription>
          Read-only file connection. Sharing files needs a separate
          confirmation.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {user && enabled ? (
          <DriveConnectionControls key={user.uid} user={user} />
        ) : (
          <Button className="min-h-11" variant="outline" onClick={onUnlock}>
            Unlock to manage Drive
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

async function nativeConsent(serverClientId: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      HushhAuth.connectDrive({ serverClientId }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new DriveConnectionNotice(
                "Finish or cancel the Google window, then check the connection.",
              ),
            ),
          3 * 60_000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof DriveConnectionNotice) throw error;
    throw new DriveConnectionNotice(
      "Google connection did not finish. Finish or cancel the Google window, then try again.",
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function DriveConnectionControls({ user }: { user: DriveUser }) {
  const requestScope = useId();
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const operation = useRef<{ cancel?: () => void; failed?: boolean } | null>(null);
  const session = useMemo(() => {
    const lifecycle = { active: false };
    try {
      return {
        lifecycle,
        context: captureDriveConnectionContext(user, () => lifecycle.active),
      };
    } catch {
      return { lifecycle, context: null };
    }
  }, [user]);
  useLayoutEffect(() => {
    session.lifecycle.active = true;
    return () => {
      session.lifecycle.active = false;
      operation.current?.cancel?.();
      operation.current = null;
    };
  }, [session]);
  const context = session.context;
  const load = useCallback(
    async (options?: { force?: boolean }) => {
      if (!context) throw new Error("Sign in again to check Drive.");
      return GoogleDriveService.status(context, options?.force);
    },
    [context],
  );
  const resource = useStaleResource({
    cacheKey: context
      ? GoogleDriveService.cacheKey(context)
      : "google_connection_inactive",
    enabled: Boolean(context),
    load,
    resourceLabel: "google-connection",
    requestScope,
  });
  const status = resource.data;
  const connected = status?.connected === true && status.status === "connected";

  const connect = () => {
    if (!context || operation.current) return;
    const task = { failed: false };
    operation.current = task;
    const activeContext = {
      ...context,
      isEffectCurrent: () =>
        context.isEffectCurrent() && operation.current === task && !task.failed,
    };
    setBusy(true);
    // Open synchronously inside the click, before identity or network awaits.
    const attempt = Capacitor.isNativePlatform()
      ? null
      : createGoogleOAuthPopupAttempt("drive");
    const popup = attempt ? openGoogleOAuthPopup(attempt) : null;
    const waiter =
      popup && attempt
        ? waitForGoogleOAuthPopup(
            popup,
            attempt,
            () => isDriveConnectionCurrent(activeContext),
            () => {
              task.failed = true;
            },
          )
        : null;
    if (waiter) Object.assign(task, { cancel: waiter.cancel });
    const run = async () => {
      if (Capacitor.isNativePlatform()) {
        const start = await GoogleDriveService.startNative(activeContext);
        if (!isDriveConnectionCurrent(activeContext))
          throw new DOMException("Connection session changed.", "AbortError");
        const result = await nativeConsent(start.server_client_id);
        const completed = await GoogleDriveService.completeNative(
          activeContext,
          start.state,
          result.serverAuthCode,
        );
        if (!completed.connected)
          throw new DriveConnectionNotice(
            "Drive connection was not confirmed. Please try again.",
          );
      } else {
        if (!popup || !waiter)
          throw new DriveConnectionNotice(
            "Allow popups for this app, then connect Drive again.",
          );
        const start = await GoogleDriveService.startWeb(activeContext);
        if (!isDriveConnectionCurrent(activeContext))
          throw new DOMException("Connection session changed.", "AbortError");
        navigateGoogleOAuthPopup(popup, start.authorize_url);
        await waiter.promise;
        GoogleDriveService.invalidate(activeContext);
        // Acknowledged connection and failed refresh are different outcomes.
        try {
          const refreshed = await GoogleDriveService.status(
            activeContext,
            true,
          );
          if (!refreshed.connected || refreshed.status !== "connected") {
            throw new DriveConnectionNotice(
              "Drive is not connected. Refresh its status or reconnect.",
            );
          }
        } catch (error) {
          if (
            error instanceof DriveConnectionNotice ||
            error instanceof DOMException
          )
            throw error;
          throw new DriveConnectionNotice(
            "Drive connected, but its status could not refresh. Use Refresh to check it.",
          );
        }
      }
    };
    const pending = run();
    void morphyToast.promise(pending, {
      loading: "Connecting Google Drive…",
      success: "Google Drive connected.",
      error: (error: unknown) =>
        error instanceof DOMException
          ? "Connection stopped. Check its status before trying again."
          : error instanceof DriveConnectionNotice ||
              error instanceof GoogleOAuthPopupWaitError
            ? error.message
            : "Drive could not be connected.",
    });
    void pending
      .catch(() => undefined)
      .finally(() => {
        waiter?.cancel();
        if (operation.current === task) {
          operation.current = null;
          if (session.lifecycle.active) setBusy(false);
        }
      });
  };

  const disconnect = () => {
    if (!context || operation.current) return;
    const task = {};
    operation.current = task;
    const activeContext = {
      ...context,
      isEffectCurrent: () =>
        context.isEffectCurrent() && operation.current === task,
    };
    setBusy(true);
    const pending = GoogleDriveService.disconnect(activeContext).then(
      (result) => {
        if (result.connected)
          throw new Error("Drive is still connected. Please try again.");
        if (session.lifecycle.active) setConfirmDisconnect(false);
      },
    );
    void morphyToast.promise(pending, {
      loading: "Disconnecting Google Drive…",
      success: "Google Drive disconnected.",
      error:
        "Drive could not be disconnected. Refresh its status before trying again.",
      variant: "destructive",
    });
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (operation.current === task) {
          operation.current = null;
          if (session.lifecycle.active) setBusy(false);
        }
      });
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          {!context
            ? "Sign in again to check Drive."
            : resource.error
              ? "We couldn’t check Drive. Try Refresh."
              : !status
                ? "Checking Drive connection…"
                : connected
                  ? "Connected · read-only"
                  : status.status === "needs_reauth"
                    ? "Reconnect to continue."
                    : !status.configured
                      ? "Drive connection is unavailable right now."
                      : "Not connected"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            variant="ghost"
            aria-label="Refresh Drive connection"
            disabled={
              !context || busy || resource.loading || resource.refreshing
            }
            onClick={() => void resource.refresh({ force: true })}
          >
            Refresh
          </Button>
          {connected ? (
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect Drive
            </Button>
          ) : (
            <Button
              className="min-h-11"
              disabled={busy || !status?.configured || Boolean(resource.error)}
              onClick={connect}
            >
              {busy
                ? "Connecting…"
                : status?.status === "needs_reauth"
                  ? "Reconnect Drive"
                  : "Connect Drive"}
            </Button>
          )}
        </div>
      </div>
      {connected && status.google_email ? (
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Connected as {status.google_email}
        </p>
      ) : null}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Drive?</AlertDialogTitle>
            <AlertDialogDescription>
              One will stop reading your Drive files. Your files and other
              connected services stay unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep connected
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                disconnect();
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
