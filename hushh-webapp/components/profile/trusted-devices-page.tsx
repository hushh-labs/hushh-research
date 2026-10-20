"use client";

import {
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
import { deriveSyncDisplay } from "@/lib/trusted-device/sync-display";
import { cn } from "@/lib/utils";
import { UNLINK_WARNING, type TrustedDevicesModel } from "./use-trusted-devices-model";

/** Trusted devices is a recursive Profile-pane detail, not a standalone page. */
export default function TrustedDevicesPage({
  panePresentation = false, model,
}: {
  panePresentation?: boolean;
  model: TrustedDevicesModel;
}) {
  const { devices, confirmation: pendingRevocation, busy: revoking, loading, error: visibleError } = model;

  const nowMs = Date.now();

  const pageContent = (
    <>
      <AppPageHeaderRegion>
        <PageHeader
          title="Trusted devices"
          // The pane's top bar already names this screen; one title per screen.
          titleVisuallyHidden
          description={panePresentation ? undefined : "Computers connected as an extension of your private agent."}
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
          {visibleError ? (
            <p
              className={cn(
                "text-sm text-destructive",
                panePresentation && typographyStyles.status,
              )}
            >
              {visibleError} <button type="button" disabled={revoking} onClick={() => void model.refresh()}>Refresh</button>
            </p>
          ) : null}
          {devices.length > 0 ? (
            <SettingsGroup title={panePresentation ? "Connected devices" : undefined} separatorInset>
              {devices.map((device) => {
                const sync = deriveSyncDisplay(device, nowMs);
                const isActive = device.status === "active";
                return (
                  <SettingsRow
                    key={device.device_id}
                    icon={panePresentation ? PROFILE_ICONS.devices : DevicesProfileIcon}
                    iconTone="capability"
                    title={device.device_name}
                    description={sync.label}
                    trailing={
                      isActive ? (
                        <Button
                          aria-label={`Unlink ${device.device_name}`}
                          onClick={() => model.choose(device.device_id)}
                          disabled={revoking || model.uncertain}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : undefined
                    }
                    trailingInteractive={isActive}
                  />
                );
              })}
            </SettingsGroup>
          ) : null}
          {!loading && devices.length === 0 ? (
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
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking || model.uncertain || pendingRevocation === null}
              onClick={(event) => {
                event.preventDefault();
                void model.confirm();
              }}
            >
              {revoking ? "Unlinking…" : "Unlink device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
