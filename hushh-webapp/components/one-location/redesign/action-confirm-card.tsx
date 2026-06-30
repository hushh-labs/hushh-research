"use client";

import { Eye, Link as LinkIcon, MapPin, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ClientAction } from "@/lib/one-location/types";

const CONFIRM_LABEL: Record<ClientAction["type"], string> = {
  publish_share: "Share",
  view_envelope: "View",
  create_public_link: "Create link",
};

const ACTION_ICON: Record<ClientAction["type"], typeof MapPin> = {
  publish_share: Share2,
  view_envelope: Eye,
  create_public_link: LinkIcon,
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
  return (
    <div
      data-testid="action-confirm-card"
      className="rounded-2xl border border-[#b8894d]/40 bg-[#b8894d]/5 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[#b8894d]">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <p className="flex-1 text-sm font-medium">{action.summary}</p>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="action-confirm-accept"
          size="sm"
          isLoading={busy}
          onClick={onConfirm}
        >
          {CONFIRM_LABEL[action.type] ?? "Confirm"}
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
