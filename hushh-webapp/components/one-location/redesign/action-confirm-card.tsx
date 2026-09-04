"use client";

import { AlertTriangle, Eye, Link as LinkIcon, MapPin, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ButtonLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import {
  roleClasses,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import type { ClientAction } from "@/lib/one-location/types";

const CONFIRM_LABEL: Record<ClientAction["type"], string> = {
  publish_share: "Share",
  view_envelope: "View",
  create_public_link: "Create link",
  sos_panic: "Send SMS",
  check_in: "Check in",
};

const ACTION_ICON: Record<ClientAction["type"], typeof MapPin> = {
  publish_share: Share2,
  view_envelope: Eye,
  create_public_link: LinkIcon,
  sos_panic: AlertTriangle,
  check_in: MapPin,
};

/**
 * What each pending action MEANS, so the card can be read before it is read.
 *
 * Every one of these is something the user is about to do, which is why they
 * are `action` rather than the status colour of their outcome — a check-in is
 * green once it has happened, not while it is still a button. The exception is
 * the SOS alert, whose whole surface elsewhere is the emergency red, and which
 * arrived here looking exactly like "share my location".
 */
const ACTION_ROLE: Record<ClientAction["type"], SemanticRole> = {
  publish_share: "action",
  view_envelope: "action",
  create_public_link: "action",
  sos_panic: "danger",
  check_in: "action",
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
  const role = ACTION_ROLE[action.type] ?? "action";
  return (
    <div
      data-testid="action-confirm-card"
      className="rounded-[18px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-4 shadow-[var(--app-card-shadow-standard)] dark:shadow-none"
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 ${roleClasses(role).glyph}`}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <RowDescription as="p" className="flex-1 text-[color:var(--app-label)]">
          {action.summary}
        </RowDescription>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="action-confirm-accept"
          size="sm"
          // Primary CTAs stay accent unless the action is genuinely
          // destructive; "Send SMS" fires the emergency alert.
          variant={role === "danger" ? "destructive" : "default"}
          isLoading={busy}
          onClick={onConfirm}
          className="ui-text-button-label"
        >
          <ButtonLabel as="span">{CONFIRM_LABEL[action.type] ?? "Confirm"}</ButtonLabel>
        </Button>
        <Button
          data-testid="action-confirm-cancel"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          className="ui-text-button-label"
        >
          <ButtonLabel as="span">Cancel</ButtonLabel>
        </Button>
      </div>
    </div>
  );
}
