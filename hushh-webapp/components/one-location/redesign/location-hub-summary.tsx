"use client";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";
import { locationStatusLabel } from "@/lib/one-location/location-readiness";
import type { LocationHubViewModel } from "./location-redesign-hub";
import { TaskFlowHeader } from "./primitives";
import { LOCATION_HEADER_ACTIONS_CLASSNAME, LOCATION_HEADER_STATUS_CLASSNAME, LOCATION_HEADER_SWITCH_CLASSNAME, LOCATION_HEADER_TOGGLE_LABEL_CLASSNAME } from "./location-header-layout";

type LocationHeaderViewModel = Pick<LocationHubViewModel,
  "locationEnabled" | "locationAcquiring" | "locationBlocked" | "locationPaused" |
  "locationAccuracyLimited" | "onShowMyLocation" | "onHideMyLocation">;

/**
 * The id the header switch points `aria-describedby` at. A constant, not
 * `useId`: the status text now renders below the switch in the actions column,
 * and `aria-describedby` resolves by id anywhere in the document. There is
 * exactly one Location header on screen.
 */
const LOCATION_HEADER_STATUS_ID = "one-location-header-status";

export function LocationRequestDurationHeader() {
  return (
    <div className="location-request-duration-header">
      <TaskFlowHeader eyebrow="Step 2 of 2" title="Request Access Duration" />
    </div>
  );
}

/** What the header switch currently means, in words. */
function locationHeaderStatusText(vm: LocationHeaderViewModel): string {
  if (vm.locationAcquiring) return "Finding you\u2026";
  const status = locationStatusLabel({
    readiness: vm.locationBlocked
      ? ("blocked" as const)
      : vm.locationEnabled
        ? ("ready" as const)
        : ("askable" as const),
    previewOn: vm.locationEnabled,
    paused: vm.locationPaused,
    accuracyLimited: vm.locationAccuracyLimited,
  });
  if (status === "Location on") return "Location on";
  if (status === "Location off") return "Location off";
  return status;
}

/** The status stays with the switch and may wrap rather than clip on a narrow phone. */
function LocationHeaderStatus({ vm }: { vm: LocationHeaderViewModel }) {
  return (
    <span
      id={LOCATION_HEADER_STATUS_ID}
      data-testid="one-location-header-status"
      className={LOCATION_HEADER_STATUS_CLASSNAME}
    >
      {locationHeaderStatusText(vm)}
    </span>
  );
}

export function LocationHeaderActions({ vm }: { vm: LocationHeaderViewModel }) {
  const locationOn = vm.locationEnabled;
  const acquiring = vm.locationAcquiring;

  const handleLocationChange = (checked: boolean) => {
    if (checked === locationOn) return;
    if (checked) {
      vm.onShowMyLocation();
      return;
    }
    vm.onHideMyLocation();
  };

  return (
    <div
      role="group"
      aria-label="Location"
      className={LOCATION_HEADER_ACTIONS_CLASSNAME}
      data-testid="one-location-header-actions"
    >
      <label htmlFor="one-location-header-toggle" className={LOCATION_HEADER_TOGGLE_LABEL_CLASSNAME}>
      <Switch
        id="one-location-header-toggle"
        size="default"
        checked={locationOn}
        onCheckedChange={handleLocationChange}
        // Deliberately never disabled. What it controls is local state that
        // flips on tap, so a disabled window could only ever swallow the
        // person's NEXT tap — during the very seconds the device spends
        // finding them, which is when they are most likely to change their
        // mind. The status text carries the waiting instead.
        aria-label={locationOn ? "Turn location off" : "Turn location on"}
        // The status text is the switch's description, not decoration. It used
        // to be aria-hidden, so a VoiceOver user got "Turn location on" and no
        // way to hear whether it was blocked, paused, or still finding them.
        aria-describedby={LOCATION_HEADER_STATUS_ID}
        // The same pair of contract actions the Settings toggle carries.
        // Both are the same control in two places, so voice can offer
        // pause/resume from the Now tab without opening Settings first.
        data-voice-control-id="one-location-updates-toggle"
        // No colour override: the shared Switch already carries the iOS
        // system green, so this toggle reads the same as every other one.
        className={cn(LOCATION_HEADER_SWITCH_CLASSNAME, acquiring && "animate-pulse")}
      />
      <LocationHeaderStatus vm={vm} />
      </label>
    </div>
  );
}

const LOCATION_INTERACTIVE_SURFACE =
  "bg-[color:var(--app-primary-surface)] ring-1 ring-inset ring-[color:var(--app-separator)]";

export function LocationPrimaryShareCard({ onClick }: { onClick: () => void }) {
  return (
    <section aria-label="Share location" data-testid="one-location-now-primary">
      <div
        data-testid="one-location-share-row"
        className={cn(
          LOCATION_INTERACTIVE_SURFACE,
          "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-4 rounded-[18px] px-4 py-4 text-left sm:flex sm:items-center sm:gap-4",
        )}
      >
        <div className="contents sm:flex sm:min-w-0 sm:flex-1 sm:items-center sm:gap-4">
          <LocationSharePulseIcon />
          <span className="min-w-0 self-center">
            <CardTitle
              as="span"
              className="block !text-[17px] !font-semibold !leading-[22px]"
            >
              You&apos;re not sharing
            </CardTitle>
            <span className="mt-0.5 block text-[13px] font-normal leading-[18px] text-[color:var(--app-secondary-label)]">
              Choose a Circle or contact.
            </span>
          </span>
        </div>
        <Button
          type="button"
          size="prominent"
          data-voice-control-id="one-location-action-share"
          data-voice-action-id="location.open_share"
          data-voice-label="Share location"
          aria-label="Share location"
          onClick={onClick}
          className="col-start-2 mr-auto w-full max-w-[244px] shrink-0 bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)] sm:mx-0 sm:w-auto sm:max-w-none"
        >
          Share location
        </Button>
      </div>
    </section>
  );
}

function LocationSharePulseIcon() {
  return (
    <span
      aria-hidden="true"
      data-location-share-pulse-icon=""
      className="relative inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] shadow-[inset_0_0_0_1px_rgba(0,122,255,0.025)] dark:shadow-none sm:h-16 sm:w-16"
    >
      <span className="absolute inset-[13%] rounded-full bg-[color:var(--app-accent-surface)]" />
      <span className="absolute inset-[28%] rounded-full bg-[color:var(--app-accent)]/20" />
      <span className="relative h-[25%] w-[25%] rounded-full bg-[color:var(--app-accent)] shadow-[0_0_0_4px_var(--app-primary-surface),0_8px_16px_rgba(0,122,255,0.18)] dark:shadow-[0_0_0_4px_var(--app-primary-surface)]" />
    </span>
  );
}
