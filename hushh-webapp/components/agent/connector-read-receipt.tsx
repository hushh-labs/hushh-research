"use client";

import { Button } from "@/lib/morphy-ux/button";
import type {
  ConnectorReadExperience,
  WorkspaceConnectorProvider,
  WorkspaceConnectorSetupExperience,
} from "@/lib/agent/connector-read-receipt";

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
const DRIVE_STATUS: Record<ConnectorReadExperience["status"], string> = {
  ok: "Drive files checked",
  input_required: "Drive needs more detail",
  connect_required: "Connect Drive to continue",
  reconnect_required: "Reconnect Drive to continue",
  connection_changed: "Drive connection changed. Try again.",
  permission_denied: "Google did not allow this read",
  source_changed: "A file or its access changed. Try again.",
  response_too_large: "Try a narrower Drive search",
  invalid_argument: "Ask a brief question about your Drive files",
  unavailable: "Drive is temporarily unavailable",
};

export function ConnectorReadReceipt({ experience, onOpenConnections }: {
  experience: ConnectorReadExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const needsConnection = ["connect_required", "reconnect_required", "permission_denied"].includes(experience.status);
  const drive = experience.connector === "drive";
  return (
    <section aria-label={drive ? "Drive read details" : "Mail read details"} className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p role="status">{(drive ? DRIVE_STATUS : STATUS_TEXT)[experience.status]}</p>
      {experience.status === "ok" ? (
        <>
          <p>{drive ? (experience.metadataOnly ? "Drive file matches" : "Drive excerpts") : "Metadata only"} · {experience.sourceRefs.length} cited {experience.sourceRefs.length === 1 ? "source" : "sources"}</p>
          {experience.sourceRefs.length > 0 ? (
            <ul aria-label={drive ? "Document sources" : "Mail sources"} className="flex flex-wrap gap-x-3 gap-y-1">
              {experience.sourceRefs.map((ref, index) => <li key={ref}>{drive ? `${experience.metadataOnly ? "File" : "Document excerpt"} ${index + 1}${experience.sourcePages?.[index] ? ` · page ${experience.sourcePages[index]}` : ""}` : `Mail ${ref.slice(5)}`}</li>)}
            </ul>
          ) : null}
          {experience.truncated ? <p>{drive && !experience.metadataOnly ? "Some document content was omitted." : "Some matches or metadata were omitted."}</p> : null}
        </>
      ) : null}
      {needsConnection && onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections(drive ? "drive" : "gmail", event.currentTarget)}>
          {experience.status === "connect_required"
            ? `Connect ${drive ? "Drive" : "Gmail"}`
            : `Review ${drive ? "Drive" : "Gmail"} access`}
        </Button>
      ) : null}
    </section>
  );
}

const WORKSPACE_PROVIDER_LABEL: Record<WorkspaceConnectorProvider, string> = {
  drive: "Drive",
  gmail: "Gmail",
  calendar: "Calendar",
  custom: "Connectors",
};

export function WorkspaceConnectorSetupCard({
  experience,
  onOpenConnections,
}: {
  experience: WorkspaceConnectorSetupExperience;
  onOpenConnections?: (provider: WorkspaceConnectorProvider, trigger: HTMLButtonElement) => void;
}) {
  const label = WORKSPACE_PROVIDER_LABEL[experience.provider];
  const manage = experience.status === "manage_available";
  return (
    <section
      aria-label={manage ? "Connectors" : `${label} connection needed`}
      className="min-w-0 space-y-2 text-sm text-muted-foreground"
      data-testid="workspace-connector-setup"
    >
      <p role="status">{manage ? "Add or manage a connector." : `Connect ${label} to continue.`}</p>
      {!manage ? <p>One will use only the access you approve. Connecting does not share information with anyone.</p> : null}
      {onOpenConnections ? (
        <Button
          type="button"
          variant="muted"
          size="compact"
          onClick={(event) => onOpenConnections(experience.provider, event.currentTarget)}
        >
          {manage ? "Open connectors" : `Connect ${label}`}
        </Button>
      ) : null}
    </section>
  );
}
