"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/morphy";
import { pkmMemoryRowLabels, type PkmMemoryCard } from "@/lib/pkm/pkm-memory-cards";

export type MemorySharingState = "loading" | "private" | "shared" | "unavailable";

function sharingRowValue(state: MemorySharingState): string {
  switch (state) {
    case "loading":
      return "Checking…";
    case "shared":
      return "Shared";
    case "unavailable":
      return "Not available";
    default:
      return "Private";
  }
}

/**
 * One memory. Source and timestamp are deliberately not shown: the underlying
 * card carries only domain-level provenance, so labelling it as this memory's
 * own would be a guess. Sharing stays — it is verified per scope with
 * getMutationSharingImpact. Editing and deletion are quiet, secondary rows.
 */
export function PkmMemoryDetail({
  card,
  sharingState,
  canMutate,
  saving,
  deleting,
  actionError,
  onBack,
  onOpenSharing,
  onSave,
  onForget,
}: {
  card: PkmMemoryCard;
  sharingState: MemorySharingState;
  canMutate: boolean;
  saving: boolean;
  deleting: boolean;
  actionError: string | null;
  onBack: () => void;
  onOpenSharing: () => void;
  onSave: (nextValue: string) => void;
  onForget: () => void;
}) {
  const { primary, secondary } = pkmMemoryRowLabels(card);
  const [editOpen, setEditOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [editValue, setEditValue] = useState(card.value);
  const busy = saving || deleting;

  useEffect(() => {
    if (!saving && !actionError) setEditOpen(false);
  }, [saving, actionError]);

  useEffect(() => {
    setEditValue(card.value);
  }, [card.id, card.value]);

  return (
    <div className="space-y-7" data-pkm-detail-panel="true" data-pkm-memory-detail="true">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex min-h-11 items-center gap-1 text-[15px] font-normal text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Memory
      </button>

      <div className="space-y-2">
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          {primary}
        </h2>
        {secondary ? (
          <p className="text-[15px] leading-7 text-muted-foreground">{secondary}</p>
        ) : null}
      </div>

      <SettingsGroup separatorInset testId="memory-detail-meta">
        <SettingsRow
          title="Sharing"
          onClick={onOpenSharing}
          ariaLabel="Open sharing settings"
          trailing={
            <span className="flex items-center gap-1 text-[15px] text-muted-foreground">
              {sharingRowValue(sharingState)}
              <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden />
            </span>
          }
        />
      </SettingsGroup>

      {actionError ? <p className="px-1 text-sm text-destructive">{actionError}</p> : null}

      <SettingsGroup separatorInset testId="memory-detail-actions">
        <SettingsRow
          title="Edit"
          disabled={!canMutate || busy}
          onClick={() => {
            setEditValue(card.value);
            setEditOpen(true);
          }}
        />
        <SettingsRow
          title="Forget Memory"
          tone="destructive"
          disabled={!canMutate || busy}
          onClick={() => setForgetOpen(true)}
          trailing={
            deleting ? <Loader2 className="h-4 w-4 animate-spin text-destructive" aria-hidden /> : undefined
          }
        />
      </SettingsGroup>

      <AlertDialog open={forgetOpen} onOpenChange={(open) => (busy ? undefined : setForgetOpen(open))}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this memory?</AlertDialogTitle>
            <AlertDialogDescription>
              One will no longer remember “{primary}”. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onForget}>
              Forget Memory
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={editOpen} onOpenChange={(open) => (saving ? undefined : setEditOpen(open))}>
        <DialogContent showCloseButton={false} className="gap-4 sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Edit Memory</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium text-foreground">{primary}</p>
          <Input
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            aria-label={`New value for ${primary}`}
            autoFocus
          />
          {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="none"
              effect="fade"
              disabled={saving}
              onClick={() => setEditOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              effect="fade"
              disabled={saving || !editValue.trim() || editValue === card.value}
              onClick={() => onSave(editValue)}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
