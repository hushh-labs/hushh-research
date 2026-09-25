"use client";

import { Button } from "@/lib/morphy-ux/button";
import type { ConnectorReadExperience } from "@/lib/agent/connector-read-receipt";
import type { DriveCompilationUiState } from "@/lib/agent/drive-batch-progress";

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
const COMPILATION_ERROR_TEXT: Record<NonNullable<DriveCompilationUiState["errorReason"]>, string> = {
  connect_required: "Connect Drive, then try again.",
  reconnect_required: "Reconnect Drive, then try again.",
  input_required: "Ask for a specific note title and date range, then try again.",
  source_changed: "Drive changed during compilation. Try again.",
  interrupted: "Compilation stopped before it finished. Try again.",
  unavailable: "Drive could not finish the compilation. Try again.",
};

export function ConnectorReadReceipt({ experience, onOpenConnections, onCompileDriveNotes,
  onDownloadDriveNotes, driveCompilation }: {
  experience: ConnectorReadExperience;
  onOpenConnections?: (trigger: HTMLButtonElement) => void;
  onCompileDriveNotes?: () => void;
  onDownloadDriveNotes?: () => void;
  driveCompilation?: DriveCompilationUiState;
}) {
  const needsConnection = ["connect_required", "reconnect_required", "permission_denied"].includes(experience.status);
  const drive = experience.connector === "drive";
  return (
    <section aria-label={drive ? "Drive read details" : "Mail read details"} className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p role="status">{(drive ? DRIVE_STATUS : STATUS_TEXT)[experience.status]}</p>
      {experience.status === "ok" ? (
        <>
          <p>{drive ? (experience.metadataOnly ? "Drive file matches" : "Drive excerpts") : "Metadata only"} · {experience.sourceRefs.length} cited {experience.sourceRefs.length === 1 ? "source" : "sources"}</p>
          {experience.sourceRefs.length > 0 && !experience.ownerCompileAvailable ? (
            <ul aria-label={drive ? "Document sources" : "Mail sources"} className="flex flex-wrap gap-x-3 gap-y-1">
              {experience.sourceRefs.map((ref, index) => <li key={ref}>{drive ? `${experience.metadataOnly ? "File" : "Document excerpt"} ${index + 1}${experience.sourcePages?.[index] ? ` · page ${experience.sourcePages[index]}` : ""}` : `Mail ${ref.slice(5)}`}</li>)}
            </ul>
          ) : null}
          {experience.truncated ? <p>{drive && !experience.metadataOnly ? "Some document content was omitted." : "Some matches or metadata were omitted."}</p> : null}
        </>
      ) : null}
      {needsConnection && onOpenConnections ? (
        <Button type="button" variant="muted" size="compact" onClick={(event) => onOpenConnections(event.currentTarget)}>
          Open Connectors
        </Button>
      ) : null}
      {drive && experience.ownerCompileAvailable && onCompileDriveNotes ? (
        <div className="space-y-2">
          {driveCompilation?.status === "ready" || driveCompilation?.status === "partial" ? (
            <p role="status">
              Compiled {driveCompilation.included} of {driveCompilation.matched} matching files.
              {driveCompilation.status === "partial" ? " Some notes were unavailable or omitted." : ""}
            </p>
          ) : null}
          {driveCompilation?.status === "error" ? (
            <p role="status">{COMPILATION_ERROR_TEXT[driveCompilation.errorReason ?? "unavailable"]}</p>
          ) : null}
          {driveCompilation?.status === "ready" || driveCompilation?.status === "partial" ? (
            <Button type="button" variant="muted" size="compact" disabled={!onDownloadDriveNotes}
              onClick={onDownloadDriveNotes}>
              Download Markdown notes
            </Button>
          ) : (
            <Button type="button" variant="muted" size="compact"
              disabled={driveCompilation?.status === "running"} onClick={onCompileDriveNotes}>
              {driveCompilation?.status === "running" ? "Compiling original notes…" :
                driveCompilation?.status === "error" ? "Try compiling again" : "Compile original notes"}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
