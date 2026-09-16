"use client";

/**
 * The Now-tab status card for the voice-first Location area.
 *
 * Three facts, three rows, never blended into one switch:
 *   1. Device permission  -- what the OS says (Allowed while using / Denied /
 *      Not asked yet). Only the device is authority here.
 *   2. Sharing with people -- the server's persisted `sharing_state`
 *      (On / Off / Not set up).
 *   3. Precision -- the persisted preference (Precise / Approximate).
 *
 * "Location is on" is said ONLY when the server says sharing_state === "on"
 * AND the OS permission is granted. Every other combination is described
 * honestly, and nothing here is derived from transcript text.
 *
 * Every write goes through the same `/api/one/location/account-settings`
 * contract the voice tools use (`turn_sharing_on`, `turn_sharing_off`,
 * `set_precision`), so tapping and speaking cannot disagree. The controls
 * hook and the confirm dialog are exported so Settings reuses them instead
 * of re-implementing the 409 handling.
 */

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import {
  Loader2,
  MapPin,
  ShieldCheck,
  Smartphone,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  locationSettingsErrorCode,
  useLocationAccountSettings,
  type LocationAccountSettings,
  type LocationAccountSettingsPatch,
} from "@/lib/location/account-settings";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import {
  ACCENT_ICON_BUBBLE,
  CARD_SURFACE,
  MUTED_TEXT,
} from "@/lib/morphy-ux/tokens/surfaces";
import { ROUTES } from "@/lib/navigation/routes";
import { OneLocationService } from "@/lib/one-location/service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

export type LocationOsPermissionFact =
  "granted" | "denied" | "prompt" | "restricted" | "unavailable" | "unknown";
export type LocationSharingStateFact = "unset" | "on" | "off";
export type LocationPrecisionFact = "precise" | "approximate";

export type LocationStatusFacts = {
  /** The device's answer. `unknown` until the platform has been asked. */
  osPermission: LocationOsPermissionFact;
  /** The server's persisted posture (`unset` = setup not completed). */
  sharingState: LocationSharingStateFact;
  precision: LocationPrecisionFact;
};

export const CONSENT_REQUIRED_CODE = "LOCATION_SHARING_CONSENT_REQUIRED";
export const SOS_ACTIVE_CODE = "LOCATION_SOS_ACTIVE";

export type LocationStatusHeadline = {
  headline: string;
  detail: string;
  tone: "live" | "pending" | "neutral";
};

/** The one sentence at the top of the card, derived from the three facts. */
export function describeLocationStatus(
  facts: LocationStatusFacts,
): LocationStatusHeadline {
  const granted = facts.osPermission === "granted";
  if (facts.sharingState === "unset") {
    return {
      headline: "Location isn't set up yet",
      detail: granted
        ? "Your device allows location, but sharing with people hasn't been set up."
        : "Finish setup to share your location with people you choose.",
      tone: "neutral",
    };
  }
  if (facts.sharingState === "on" && granted) {
    return {
      headline: "Location is on",
      detail:
        facts.precision === "approximate"
          ? "People you share with see an approximate area."
          : "People you share with see your precise position.",
      tone: "live",
    };
  }
  if (facts.sharingState === "on") {
    return {
      headline: "Sharing is on, but your device isn't sending location",
      detail:
        facts.osPermission === "denied" || facts.osPermission === "restricted"
          ? "Location permission is denied on this device, so nothing is shared right now."
          : facts.osPermission === "unavailable"
            ? "This device can't provide location, so nothing is shared right now."
            : "This device hasn't been asked for location permission yet.",
      tone: "pending",
    };
  }
  return {
    headline: "Sharing with people is off",
    detail: granted
      ? "Your device allows location, but no one can see you until you turn sharing on."
      : "No one can see your location.",
    tone: "neutral",
  };
}

export function devicePermissionLabel(
  permission: LocationOsPermissionFact,
): string {
  switch (permission) {
    case "granted":
      return "Allowed while using";
    case "denied":
      return "Denied";
    case "restricted":
      return "Restricted";
    case "unavailable":
      return "Not available";
    default:
      return "Not asked yet";
  }
}

export function sharingStateLabel(state: LocationSharingStateFact): string {
  switch (state) {
    case "on":
      return "On";
    case "off":
      return "Off";
    default:
      return "Not set up";
  }
}

export function precisionLabel(precision: LocationPrecisionFact): string {
  return precision === "approximate" ? "Approximate (~1 km)" : "Precise";
}

/* ------------------------------------------------------------------ */
/* Shared posture controls                                            */
/* ------------------------------------------------------------------ */

export type SharingPostureOutcome =
  "ok" | "consent_required" | "sos_active" | "failed";
export type SharingPostureBusy = "on" | "off" | "precision" | null;

export type SharingPostureControls = {
  busy: SharingPostureBusy;
  /** The last Turn on was refused because consent was never recorded. */
  consentRequired: boolean;
  /** The last Turn off was refused because Save My Soul is running. */
  sosBlocking: boolean;
  /** True while the Turn off confirm dialog is open. */
  confirmOffOpen: boolean;
  openConfirmOff: () => void;
  closeConfirmOff: () => void;
  turnOn: () => Promise<SharingPostureOutcome>;
  /** Called from the confirm dialog; `includeSos` only after the person chose it. */
  turnOff: (includeSos: boolean) => Promise<SharingPostureOutcome>;
  setPrecision: (
    precision: LocationPrecisionFact,
  ) => Promise<SharingPostureOutcome>;
  /** No vault token, or a write in flight. */
  disabled: boolean;
};

/**
 * On/off/precision through `/api/one/location/account-settings`, with the two
 * 409s the server can answer mapped to UI facts rather than error toasts.
 */
export function useSharingPostureControls({
  onSettingsChanged,
}: {
  onSettingsChanged?: (settings: LocationAccountSettings) => void;
} = {}): SharingPostureControls {
  const { vaultOwnerToken } = useVault();
  const account = useLocationAccountSettings();
  const [busy, setBusy] = useState<SharingPostureBusy>(null);
  const [consentRequired, setConsentRequired] = useState(false);
  const [confirmOffOpen, setConfirmOffOpen] = useState(false);
  const [sosBlocking, setSosBlocking] = useState(false);

  const applyPatch = useCallback(
    async (
      kind: Exclude<SharingPostureBusy, null>,
      patch: LocationAccountSettingsPatch,
    ): Promise<SharingPostureOutcome> => {
      if (!vaultOwnerToken) {
        morphyToast.error("Unlock your vault to change Location settings.");
        return "failed";
      }
      setBusy(kind);
      try {
        // PATCH + publish: the resource fans the server's answer out to every
        // mounted screen, so Now, Settings and Share agree at once.
        const result = await account.update(patch);
        onSettingsChanged?.(result.settings);
        return "ok";
      } catch (error) {
        const code = locationSettingsErrorCode(error);
        if (code === CONSENT_REQUIRED_CODE) return "consent_required";
        if (code === SOS_ACTIVE_CODE) return "sos_active";
        morphyToast.error(
          error instanceof Error && error.message
            ? error.message
            : "Location settings could not be saved.",
        );
        return "failed";
      } finally {
        setBusy(null);
      }
    },
    [account, onSettingsChanged, vaultOwnerToken],
  );

  const turnOn = useCallback(async () => {
    setConsentRequired(false);
    const outcome = await applyPatch("on", { sharingState: "on" });
    if (outcome === "consent_required") setConsentRequired(true);
    if (outcome === "ok") morphyToast.success("Sharing with people is on.");
    return outcome;
  }, [applyPatch]);

  const turnOff = useCallback(
    async (includeSos: boolean) => {
      const outcome = await applyPatch("off", {
        sharingState: "off",
        includeSos,
      });
      if (outcome === "sos_active") {
        setSosBlocking(true);
        return outcome;
      }
      setSosBlocking(false);
      setConfirmOffOpen(false);
      if (outcome === "ok") morphyToast.success("Sharing with people is off.");
      return outcome;
    },
    [applyPatch],
  );

  const setPrecision = useCallback(
    async (precision: LocationPrecisionFact) => {
      const outcome = await applyPatch("precision", { precision });
      if (outcome === "ok") {
        morphyToast.success(
          precision === "approximate"
            ? "Sharing precision is approximate."
            : "Sharing precision is precise.",
        );
      }
      return outcome;
    },
    [applyPatch],
  );

  const openConfirmOff = useCallback(() => setConfirmOffOpen(true), []);
  const closeConfirmOff = useCallback(() => {
    setConfirmOffOpen(false);
    setSosBlocking(false);
  }, []);

  return {
    busy,
    consentRequired,
    sosBlocking,
    confirmOffOpen,
    openConfirmOff,
    closeConfirmOff,
    turnOn,
    turnOff,
    setPrecision,
    disabled: busy !== null || !vaultOwnerToken,
  };
}

/** The Turn off confirmation; swaps to the Save My Soul explanation on 409. */
export function TurnOffSharingDialog({
  controls,
}: {
  controls: SharingPostureControls;
}) {
  const busy = controls.busy === "off";
  return (
    <Dialog
      open={controls.confirmOffOpen}
      onOpenChange={(open) => {
        if (busy) return;
        if (!open) controls.closeConfirmOff();
      }}
    >
      <DialogContent
        className="max-w-[min(420px,calc(100vw-32px))] gap-5 rounded-[24px] p-5 sm:p-6"
        showCloseButton={false}
        data-testid="location-status-turn-off-dialog"
      >
        <DialogHeader className="gap-1 text-left">
          <DialogTitle className="ui-text-card-title">
            {controls.sosBlocking
              ? "Save My Soul is active"
              : "Turn sharing off?"}
          </DialogTitle>
          <DialogDescription className="ui-text-page-subtitle">
            {controls.sosBlocking
              ? "Your emergency share is still running. Turning sharing off would stop it too, so nothing was changed. You can stop Save My Soul as well, or keep it running."
              : "Every active share and link stops right away, and you disappear from the map. People you were sharing with are told."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={controls.closeConfirmOff}
            data-testid="location-status-turn-off-cancel"
          >
            {controls.sosBlocking ? "Keep Save My Soul" : "Keep sharing"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={busy}
            onClick={() => void controls.turnOff(controls.sosBlocking)}
            data-testid="location-status-turn-off-confirm"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : controls.sosBlocking ? (
              "Turn off and stop Save My Soul"
            ) : (
              "Turn off"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inline notice after a Turn on refused for missing consent. */
export function ConsentRequiredNotice({ setupHref }: { setupHref: string }) {
  return (
    <div
      className="rounded-[var(--app-card-radius-compact,16px)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] p-3.5"
      role="status"
      data-testid="location-status-consent-required"
    >
      <p className="ui-text-row-label-emphasized">
        Accept the Location consent first
      </p>
      <p className={MUTED_TEXT}>
        Sharing stays off until you accept the Location sharing consent in
        setup.
      </p>
      <Button asChild variant="link" size="sm" className="mt-1 px-0">
        <Link href={setupHref}>Open setup</Link>
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                               */
/* ------------------------------------------------------------------ */

function StatusRow({
  icon,
  label,
  value,
  valueTone = "neutral",
  action,
  testId,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueTone?: "ready" | "pending" | "live" | "neutral";
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex min-h-11 items-center gap-3 py-2"
      data-testid={testId}
      data-value={value}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          ACCENT_ICON_BUBBLE,
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="ui-text-row-label">{label}</p>
        <p className={MUTED_TEXT}>{value}</p>
      </div>
      {action ? (
        <div className="shrink-0">{action}</div>
      ) : (
        <StatusPill tone={valueTone} className="shrink-0">
          {value}
        </StatusPill>
      )}
    </div>
  );
}

export type LocationStatusCardProps = {
  facts: LocationStatusFacts;
  /** True while the facts are still being read; controls stay disabled. */
  loading?: boolean;
  /** The server's answer after a successful write; the owner refreshes from it. */
  onSettingsChanged?: (settings: LocationAccountSettings) => void;
  /** Where "Set up" / "Open setup" send the person. */
  setupHref?: string;
  className?: string;
};

export function LocationStatusCard({
  facts,
  loading = false,
  onSettingsChanged,
  setupHref = ROUTES.ONE_SETUP_LOCATION,
  className,
}: LocationStatusCardProps) {
  const controls = useSharingPostureControls({ onSettingsChanged });
  const status = describeLocationStatus(facts);
  const granted = facts.osPermission === "granted";
  const isOn = facts.sharingState === "on";
  const disabled = loading || controls.disabled;

  const openDeviceSettings = useCallback(() => {
    void OneLocationService.openAppSettings().catch(() => {
      morphyToast.info("Open your device Settings to allow location for One.");
    });
  }, []);

  return (
    <section
      className={cn(CARD_SURFACE, "space-y-4 p-5", className)}
      data-testid="location-status-card"
      data-status-tone={status.tone}
      aria-busy={controls.busy !== null}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
            status.tone === "live"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
              : ACCENT_ICON_BUBBLE,
          )}
          aria-hidden="true"
        >
          <ShieldCheck className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="ui-text-headline"
            data-testid="location-status-headline"
          >
            {loading ? "Checking your location status" : status.headline}
          </p>
          <p className={MUTED_TEXT}>
            {loading ? "One moment." : status.detail}
          </p>
        </div>
        {loading ? (
          <Loader2
            className="h-5 w-5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
      </div>

      <div className="divide-y divide-[color:var(--app-separator)]">
        <StatusRow
          testId="location-status-device-row"
          icon={<Smartphone className="h-4 w-4" />}
          label="Device permission"
          value={devicePermissionLabel(facts.osPermission)}
          valueTone={
            granted
              ? "ready"
              : facts.osPermission === "denied"
                ? "pending"
                : "neutral"
          }
          action={
            facts.osPermission === "denied" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openDeviceSettings}
                className="min-h-11"
              >
                Open Settings
              </Button>
            ) : undefined
          }
        />
        <StatusRow
          testId="location-status-sharing-row"
          icon={<UsersRound className="h-4 w-4" />}
          label="Sharing with people"
          value={sharingStateLabel(facts.sharingState)}
          valueTone={isOn ? "ready" : "neutral"}
          action={
            facts.sharingState === "unset" ? (
              <Button asChild variant="outline" size="sm" className="min-h-11">
                <Link href={setupHref} data-testid="location-status-setup-link">
                  Set up
                </Link>
              </Button>
            ) : isOn ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={disabled}
                onClick={controls.openConfirmOff}
                data-testid="location-status-turn-off"
              >
                {controls.busy === "off" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Turn off"
                )}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                disabled={disabled}
                onClick={() => void controls.turnOn()}
                data-testid="location-status-turn-on"
              >
                {controls.busy === "on" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Turn on"
                )}
              </Button>
            )
          }
        />
        <StatusRow
          testId="location-status-precision-row"
          icon={<MapPin className="h-4 w-4" />}
          label="Precision"
          value={precisionLabel(facts.precision)}
          action={
            facts.sharingState === "unset" ? undefined : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                disabled={disabled}
                onClick={() =>
                  void controls.setPrecision(
                    facts.precision === "approximate"
                      ? "precise"
                      : "approximate",
                  )
                }
                aria-label={
                  facts.precision === "approximate"
                    ? "Switch to precise sharing"
                    : "Switch to approximate sharing"
                }
                data-testid="location-status-precision-toggle"
              >
                {controls.busy === "precision" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : facts.precision === "approximate" ? (
                  "Use precise"
                ) : (
                  "Use approximate"
                )}
              </Button>
            )
          }
        />
      </div>

      {controls.consentRequired ? (
        <ConsentRequiredNotice setupHref={setupHref} />
      ) : null}

      <TurnOffSharingDialog controls={controls} />
    </section>
  );
}
