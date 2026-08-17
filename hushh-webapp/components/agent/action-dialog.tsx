"use client";

import { useMemo } from "react";
import { SpecialistDirectiveCard } from "@/components/agent/specialist-directive-card";
import { isReadOnlyLocationQuery } from "@/lib/agent/tools/location-tools";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";

export type ActionDialogProps = {
  directiveEvent: SpecialistDirectiveEvent;
  busy?: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
};

/**
 * ActionDialog component wrapper that renders the double-confirmation / authorization
 * modal card exclusively for action-tier, state-changing, or navigation proposal tools.
 *
 * Enforces safety: Read-only queries will fail closed and NOT render an ActionDialog.
 */
export function ActionDialog({
  directiveEvent,
  busy = false,
  onConfirm,
  onCancel,
}: ActionDialogProps) {
  const payload = (directiveEvent.directive?.payload ?? {}) as Record<string, unknown>;
  const directiveType = String(payload.type ?? payload.kind ?? "");

  // Safety Gate: Ensure read-only query directives never render an ActionDialog
  const isReadOnly = useMemo(() => {
    return isReadOnlyLocationQuery(directiveType);
  }, [directiveType]);

  if (isReadOnly) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[ActionDialog] Prevented rendering confirmation modal for read-only query: ${directiveType}`,
      );
    }
    return null;
  }

  // Determine button labels based on action type
  const confirmLabel = useMemo(() => {
    if (directiveType === "sos_panic") return "Send SMS";
    if (directiveType === "request_device_location_permission") return "Allow location";
    if (directiveType === "revoke_location_share" || directiveType === "revoke_public_link") {
      return "Revoke";
    }
    if (directiveType === "view_envelope" || directiveType === "propose_location_view") {
      return "Open route";
    }
    if (typeof payload.confirmLabel === "string" && payload.confirmLabel.trim()) {
      return payload.confirmLabel.trim();
    }
    return "Authorize";
  }, [directiveType, payload.confirmLabel]);

  const summary = String(payload.summary ?? directiveEvent.message ?? "Authorize this action to proceed.");

  return (
    <div className="action-dialog-wrapper my-3" data-action-id={directiveType}>
      <SpecialistDirectiveCard
        summary={summary}
        confirmLabel={confirmLabel}
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}
