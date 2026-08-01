"use client";

import {
  AlertTriangle,
  Crosshair,
  Eye,
  Link as LinkIcon,
  MapPin,
  Share2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ClientAction } from "@/lib/one-location/types";

const CONFIRM_LABEL: Record<ClientAction["type"], string> = {
  publish_share: "Share",
  view_envelope: "View",
  create_public_link: "Create link",
  sos_panic: "Send SMS",
  check_in: "Check in",
  request_device_location_permission: "Continue",
};

const ACTION_ICON: Record<ClientAction["type"], typeof MapPin> = {
  publish_share: Share2,
  view_envelope: Eye,
  create_public_link: LinkIcon,
  sos_panic: AlertTriangle,
  check_in: MapPin,
  request_device_location_permission: Crosshair,
};

export function ActionConfirmCard({
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  action: ClientAction;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const Icon = ACTION_ICON[action.type] ?? MapPin;
  const locationMode =
    action.locationMode ?? action.shares?.[0]?.locationMode ?? null;
  const durationHours =
    action.durationHours ?? action.shares?.[0]?.durationHours ?? null;
  const confirmLabel =
    action.type === "publish_share"
      ? locationMode === "precise"
        ? "Start live location"
        : "Start area updates"
      : action.type === "create_public_link"
        ? "Create one-time link"
        : (CONFIRM_LABEL[action.type] ?? "Confirm");
  return (
    <div
      data-testid="action-confirm-card"
      className="rounded-2xl border border-primary/20 bg-primary/5 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-primary">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <p className="flex-1 text-sm font-medium">{action.summary}</p>
      </div>
      {locationMode || durationHours ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {locationMode ? (
            <span className="rounded-full bg-background/80 px-2.5 py-1">
              {action.type === "create_public_link"
                ? locationMode === "precise"
                  ? "Precise point · captured once"
                  : "Approximate area · captured once"
                : locationMode === "precise"
                  ? "Live location"
                  : "Area updates"}
            </span>
          ) : null}
          {durationHours ? (
            <span className="rounded-full bg-background/80 px-2.5 py-1">
              {durationHours}h
            </span>
          ) : null}
        </div>
      ) : null}
      {action.type === "create_public_link" ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-400/10 dark:text-amber-100">
          Anyone who receives this link can view the fixed snapshot until it
          expires or you revoke it. It never follows your movement.
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="action-confirm-accept"
          size="sm"
          isLoading={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button
          data-testid="action-confirm-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
