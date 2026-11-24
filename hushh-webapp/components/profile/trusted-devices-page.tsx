"use client";

import {
  Globe,
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";
import { DevicesProfileIcon } from "@/components/icons/agents";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import typographyStyles from "@/components/profile/profile-secondary-typography.module.css";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  deriveBrowserSessionDisplay,
  deriveSyncDisplay,
} from "@/lib/trusted-device/sync-display";
import { cn } from "@/lib/utils";
import { TrustedDeviceProofFields } from "./trusted-device-proof-fields";
import { UNLINK_WARNING, type TrustedDevicesModel } from "./use-trusted-devices-model";

/** Trusted devices is a recursive Profile-pane detail, not a standalone page. */
export default function TrustedDevicesPage({
  panePresentation = false,
  model,
  renderConfirmation = true,
}: {
  panePresentation?: boolean;
  model: TrustedDevicesModel;
  renderConfirmation?: boolean;
}) {
  const {
    devices,
    busy: revoking,
    loading,
    error: visibleError,
    currentBrowserDeviceId,
    pruningWeb,
    pruneNotice,
  } = model;

  const { puppyAccess, byocReady, changingPuppy, puppyNotice, pendingPuppyWithdrawal, pendingPodRevocations } = model;
  const nowMs = Date.now();

  const linkedDevices = devices.filter((device) => device.platform !== "web");
  const activeWebBrowsers = devices
    .filter((device) => device.platform === "web" && device.status === "active")
    .sort((a, b) => {
      if (a.device_id === currentBrowserDeviceId) return -1;
      if (b.device_id === currentBrowserDeviceId) return 1;
      const aTs = Math.max(a.last_used_at ?? 0, a.created_at ?? 0);
      const bTs = Math.max(b.last_used_at ?? 0, b.created_at ?? 0);
      return bTs - aTs;
    });
  const hasCurrentBrowser = Boolean(
    currentBrowserDeviceId &&
      activeWebBrowsers.some((device) => device.device_id === currentBrowserDeviceId),
  );
  const otherActiveWebBrowsers = hasCurrentBrowser
    ? activeWebBrowsers.filter((device) => device.device_id !== currentBrowserDeviceId)
    : activeWebBrowsers;
  const hasVisibleDevices = linkedDevices.length > 0 || activeWebBrowsers.length > 0;

  const pageContent = (
    <>
      <AppPageHeaderRegion>
        <PageHeader
          title="Trusted devices"
          // The pane's top bar already names this screen; one title per screen.
          titleVisuallyHidden
          description={panePresentation ? undefined : "Computers and browser sessions connected to Agent One."}
          className={panePresentation ? "sr-only" : undefined}
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SettingsPresentationProvider density="compact">
          {loading ? (
            <div
              className={cn(
                "flex items-center gap-2 text-sm text-muted-foreground",
                panePresentation && typographyStyles.status,
              )}
            >
              <Loader2 className="size-4 animate-spin" /> Loading devices…
            </div>
          ) : null}
          {model.verificationUnfinished ? <p role="status" className="text-sm text-muted-foreground">Phone verification is unfinished. Choose a device to start a new check.</p> : null}
          {visibleError ? (
            <p
              className={cn(
                "text-sm text-destructive",
                panePresentation && typographyStyles.status,
              )}
            >
              {visibleError} {model.cancellableVerification ? <button type="button" disabled={revoking} onClick={() => void model.cancel()}>Cancel unfinished verification</button> : null} <button type="button" disabled={revoking} onClick={() => void model.refresh()}>Refresh</button>
            </p>
          ) : null}
          {!visibleError && pendingPodRevocations.length > 0 ? <Button type="button" variant="outline" disabled={revoking || model.refreshing} onClick={() => void model.refresh()}>Refresh</Button> : null}
          {pendingPodRevocations.length > 0 ? <p role="status" className="text-sm text-muted-foreground">Device access is removed from your account. Pod access revocation is still pending; reconnect to your pod and try again.</p> : null}
          {puppyNotice ? (
            <p className="text-sm text-muted-foreground">{puppyNotice}</p>
          ) : null}
          {pruneNotice ? (
            <p role="status" className="text-sm text-muted-foreground">{pruneNotice}</p>
          ) : null}
          <div className="space-y-5">
            {linkedDevices.length > 0 ? (
              <SettingsGroup
                title="Linked computers & apps"
                separatorInset
                testId="trusted-linked-devices-group"
              >
                {linkedDevices.map((device) => {
                  const sync = deriveSyncDisplay(device, nowMs);
                  const isActive = device.status === "active";
                  return (
                    <SettingsRow
                      key={device.device_id}
                      icon={panePresentation ? PROFILE_ICONS.devices : DevicesProfileIcon}
                      iconTone="capability"
                      title={device.device_name}
                      description={sync.label}
                      stackTrailingOnMobile
                      trailing={
                        isActive ||
                        pendingPodRevocations.includes(device.device_id) ? (
                          <div className="flex items-center gap-2">
                            {isActive &&
                            byocReady &&
                            device.platform === "macos" &&
                            puppyAccess[device.device_id] !== undefined ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={changingPuppy !== null || revoking || model.uncertain}
                                onClick={() => void model.changePuppyAccess(device.device_id)}
                              >
                                {changingPuppy === device.device_id ? "Updating…" : pendingPuppyWithdrawal.includes(device.device_id) ? "Retry withdrawal" : puppyAccess[device.device_id] ? "Disable Puppy" : "Enable Puppy"}
                              </Button>
                            ) : null}
                            <Button
                              aria-label={`${pendingPodRevocations.includes(device.device_id) ? "Retry unlinking" : "Unlink"} ${device.device_name}`}
                              onClick={() => model.choose(device.device_id)}
                              disabled={revoking || changingPuppy !== null || model.uncertain}
                              size="icon"
                              variant="ghost"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        ) : undefined
                      }
                      trailingInteractive={
                        isActive ||
                        pendingPodRevocations.includes(device.device_id)
                      }
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}

            {activeWebBrowsers.length > 0 ? (
              <SettingsGroup
                title="Web browsers"
                titleAction={
                  otherActiveWebBrowsers.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="prune-web-browsers-button"
                      disabled={revoking || pruningWeb || model.uncertain}
                      onClick={() => model.openPruneWebConfirm()}
                    >
                      {pruningWeb
                        ? "Signing out…"
                        : hasCurrentBrowser
                          ? "Sign out other browsers"
                          : "Sign out all browsers"}
                    </Button>
                  ) : undefined
                }
                separatorInset
                testId="trusted-web-browsers-group"
              >
                {activeWebBrowsers.map((device) => {
                  const isCurrent =
                    Boolean(currentBrowserDeviceId) &&
                    device.device_id === currentBrowserDeviceId;
                  const sessionDisplay = deriveBrowserSessionDisplay(device, {
                    isCurrent,
                    nowMs,
                  });
                  return (
                    <SettingsRow
                      key={device.device_id}
                      icon={Globe}
                      iconTone="gray"
                      title={
                        <span className="inline-flex items-center gap-2">
                          <span className="truncate">{device.device_name}</span>
                          {isCurrent ? (
                            <span
                              data-testid="current-browser-badge"
                              className="inline-flex shrink-0 items-center rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium leading-4 text-emerald-700 dark:text-emerald-300"
                            >
                              Current
                            </span>
                          ) : null}
                        </span>
                      }
                      description={sessionDisplay.label}
                      trailing={
                        <Button
                          aria-label={`Unlink ${device.device_name}`}
                          onClick={() => model.choose(device.device_id)}
                          disabled={revoking || pruningWeb || changingPuppy !== null || model.uncertain}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      }
                      trailingInteractive
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}
          </div>
          {!loading && !hasVisibleDevices ? (
            <p
              className={cn(
                "rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground",
                panePresentation && typographyStyles.status,
              )}
            >
              No trusted devices are connected.
            </p>
          ) : null}
        </SettingsPresentationProvider>
      </AppPageContentRegion>
      {renderConfirmation ? <TrustedDeviceConfirmation model={model} /> : null}
    </>
  );

  return (
    <div
      className={cn(
        "profile-inner-devices w-full",
        panePresentation && typographyStyles.paneDevices,
      )}
    >
      {pageContent}
    </div>
  );
}

/** Mounted by the existing admitted Profile overlay port in native mode. */
export function TrustedDeviceConfirmation({ model }: { model: TrustedDevicesModel }) {
  const { confirmation: pendingRevocation, busy: revoking, pruneWebConfirmOpen, pruningWeb } = model;
  const hasCurrentBrowser = Boolean(
    model.currentBrowserDeviceId &&
      model.devices.some(
        (device) =>
          device.platform === "web" &&
          device.status === "active" &&
          device.device_id === model.currentBrowserDeviceId,
      ),
  );
  return (
    <>
      <AlertDialog
        open={pendingRevocation !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) model.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {pendingRevocation?.device_name || "this device"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {UNLINK_WARNING}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <TrustedDeviceProofFields model={model} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking || model.uncertain || pendingRevocation === null || !model.proof.view?.codeSent}
              onClick={(event) => {
                event.preventDefault();
                void model.confirm();
              }}
            >
              {revoking ? "Checking…" : "Unlink device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pruneWebConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !pruningWeb) model.closePruneWebConfirm();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasCurrentBrowser ? "Sign out other browsers?" : "Sign out all browsers?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {hasCurrentBrowser
                ? "Revokes access for every other web browser session while keeping this browser and your linked computers connected."
                : "Revokes access for all active web browser sessions while keeping your linked computers and native apps connected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pruningWeb}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pruningWeb || model.uncertain}
              onClick={(event) => {
                event.preventDefault();
                void model.confirmPruneWebBrowsers();
              }}
            >
              {pruningWeb
                ? "Signing out…"
                : hasCurrentBrowser
                  ? "Sign out other browsers"
                  : "Sign out all browsers"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
