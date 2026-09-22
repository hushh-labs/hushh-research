"use client";

import { Button } from "@/lib/morphy-ux/button";
import type { ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";

const STATUS_TEXT: Record<ConnectorReadExperience["status"], string> = {
  ok: "Mail metadata checked",
  input_required: "Mail needs more detail",
  connect_required: "Connect Mail to continue",
  reconnect_required: "Reconnect Mail to continue",
  connection_changed: "Mail connection changed. Try again.",
  permission_denied: "Mail did not allow this read",
  source_changed: "Your inbox changed. Try again.",
  response_too_large: "Try a narrower inbox search",
  invalid_argument: "Ask for an inbox search or messages needing a reply",
  unavailable: "Mail is temporarily unavailable",
};

export function ConnectorReadReceipt({ experience, onOpenConnections }: {
  experience: ConnectorReadExperience;
  onOpenConnections?: (trigger: HTMLButtonElement) => void;
}) {
  const needsConnection = ["connect_required", "reconnect_required", "permission_denied"].includes(experience.status);
  return (
    <section aria-label="Mail read details" className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p role="status">{STATUS_TEXT[experience.status]}</p>
      {experience.status === "ok" ? (
        <>
          <p>Metadata only · {experience.sourceRefs.length} cited {experience.sourceRefs.length === 1 ? "source" : "sources"}</p>
          {experience.sourceRefs.length > 0 ? (
            <ul aria-label="Mail sources" className="flex flex-wrap gap-x-3 gap-y-1">
              {experience.sourceRefs.map((ref) => <li key={ref}>Mail {ref.slice(5)}</li>)}
            </ul>
          ) : null}
          {experience.truncated ? <p>Some matches or metadata were omitted.</p> : null}
        </>
      ) : null}
      {needsConnection && onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections(event.currentTarget)}>
          Open Connections
        </Button>
      ) : null}
    </section>
  );
}
