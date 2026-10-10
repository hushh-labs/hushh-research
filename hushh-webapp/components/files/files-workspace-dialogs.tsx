"use client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { FilesSettings } from "@/lib/files/service";
import type { FileEdit } from "./files-entry-row";
import { FilesMovePicker } from "./files-move-picker";
import { FilesSettingsPanel, type FilesAction } from "./files-settings-panel";
import { FilesOrganizationHistory } from "./files-organization-history";

export function FilesMoveDialog({
  edit,
  signal,
  busy,
  loading,
  onCancel,
  onSave,
  onDestinationChange,
  onLoadingChange,
}: {
  edit: FileEdit | null;
  signal: AbortSignal;
  busy: boolean;
  loading: boolean;
  onCancel: () => void;
  onSave: () => void;
  onDestinationChange: (value: string) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  return (
    <Dialog
      open={edit?.operation === "move"}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent srDescription="Choose a destination folder for this file.">
        <DialogHeader>
          <DialogTitle>Move {edit?.entry?.name}</DialogTitle>
        </DialogHeader>
        {edit?.operation === "move" && edit.entry ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <FilesMovePicker
              key={edit.entry.id}
              entry={edit.entry}
              signal={signal}
              onDestinationChange={(value) => onDestinationChange(value)}
              onLoadingChange={onLoadingChange}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => onCancel()}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || loading || edit.value === edit.entry.parent}
              >
                Move here
              </Button>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function FilesDetailsDialog({
  panel,
  ownerId,
  signal,
  settings,
  busy,
  unavailable,
  act,
  onClose,
}: {
  panel: "settings" | "activity" | null;
  ownerId: string | undefined;
  signal: AbortSignal;
  settings: FilesSettings | null;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={panel !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        srDescription={
          panel === "settings"
            ? "Storage, retention and organization preferences for your private library."
            : "Organization jobs and their recorded outcomes."
        }
      >
        <DialogHeader>
          <DialogTitle>
            {panel === "settings" ? "File settings" : "Files activity"}
          </DialogTitle>
        </DialogHeader>
        {panel === "activity" && ownerId ? (
          <FilesOrganizationHistory
            key={`history:${ownerId}`}
            ownerId={ownerId}
          />
        ) : panel === "settings" ? (
          <FilesSettingsPanel
            key={`settings:${ownerId}`}
            settings={settings}
            signal={signal}
            busy={busy}
            unavailable={unavailable}
            act={act}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
