"use client";

import { CircleCheck } from "@/components/icons";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import type {
  LocationPrecision,
  LocationSharingState,
} from "@/lib/location/account-settings";
import type { LocationOsPermission } from "@/lib/location/sharing-state";
import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { CARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { cn } from "@/lib/utils";

import { osPermissionLabel } from "./os-permission-step";

export type DoneStepProps = {
  busy: boolean;
  /** Server says setup is complete (sharing was turned on by `complete`). */
  completed: boolean;
  /** The device's current answer. */
  permission: LocationOsPermission;
  /** The server's persisted posture. Never inferred. */
  sharingState: LocationSharingState;
  precision: LocationPrecision;
  /** Calls the same `complete` PATCH the `advance_location_setup(step=complete)` tool calls. */
  onFinish: () => void;
};

/**
 * What the app-sharing row may say. "On" only when the server's persisted
 * state is on; before `complete` it is honestly "turns on when you finish".
 */
export function appSharingLabel(
  sharingState: LocationSharingState,
  completed: boolean,
): { label: string; tone: "ready" | "pending" | "neutral" } {
  if (sharingState === "on") return { label: "On", tone: "ready" };
  if (sharingState === "off") return { label: "Off", tone: "neutral" };
  return completed
    ? { label: "Not set", tone: "neutral" }
    : { label: "Turns on when you finish", tone: "pending" };
}

/** Recap of the three separate facts, then the one tap that turns sharing on. */
export function DoneStep({
  busy,
  completed,
  permission,
  sharingState,
  precision,
  onFinish,
}: DoneStepProps) {
  const sharing = appSharingLabel(sharingState, completed);
  const osGranted = permission === "granted";
  const rows: Array<{
    key: string;
    label: string;
    value: string;
    tone: "ready" | "pending" | "neutral";
  }> = [
    {
      key: "device",
      label: "Device permission",
      value: osPermissionLabel(permission),
      tone: osGranted
        ? "ready"
        : permission === "denied" || permission === "restricted"
          ? "pending"
          : "neutral",
    },
    {
      key: "app",
      label: "Sharing in Hussh",
      value: sharing.label,
      tone: sharing.tone,
    },
    {
      key: "precision",
      label: "Precision",
      value: precision === "approximate" ? "Approximate" : "Precise",
      tone: "neutral",
    },
  ];

  const headline = completed
    ? sharingState === "on" && osGranted
      ? "You're set. Sharing is on."
      : sharingState === "on"
        ? "Sharing is on, but your device is blocking location."
        : "Setup is complete."
    : "Almost there.";

  return (
    <div className="space-y-6" data-testid="location-setup-done">
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
              completed && sharingState === "on" && osGranted
                ? "bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]"
                : "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]",
            )}
          >
            <CircleCheck className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <MediumRowLabel as="p" data-testid="location-setup-done-headline">
              {headline}
            </MediumRowLabel>
            <RowDescription className="mt-0.5">
              {completed
                ? "Turning sharing on allows shares; it does not start one. Name someone to share with them."
                : "Finishing records your setup and turns sharing on. It does not share anything with anyone yet."}
            </RowDescription>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-[color:var(--app-separator)] border-t border-[color:var(--app-separator)]">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex min-h-[44px] items-center justify-between gap-3 py-2"
              data-testid={`location-setup-done-row-${row.key}`}
            >
              <dt className="ui-text-row-label">{row.label}</dt>
              <dd>
                <StatusPill tone={row.tone}>{row.value}</StatusPill>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="space-y-3">
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={onFinish}
          isLoading={busy}
          disabled={busy}
          data-testid="location-setup-finish"
        >
          {completed ? "Continue" : "Finish setup"}
        </Button>
        {!osGranted ? (
          <HelperText className="text-center">
            Your device permission is{" "}
            {osPermissionLabel(permission).toLowerCase()}, so nothing can be
            shared until you allow it in Settings.
          </HelperText>
        ) : null}
      </div>
    </div>
  );
}
