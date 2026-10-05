"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  SpinnerGapIcon as Loader2,
} from "@/components/icons";

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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { reservedOwnerGlyph } from "@/components/agent/reserved-offer-rows";
import { Button } from "@/lib/morphy-ux/morphy";
import { pkmMemoryRowLabels, type PkmMemoryCard } from "@/lib/pkm/pkm-memory-cards";

export type MemorySharingState = "loading" | "private" | "shared" | "unavailable";

/**
 * The two real encrypted-PKM sharing postures for a memory's scope. `null` means
 * the scope's posture could not be resolved (no materialized share bundle, or the
 * manifest failed to load) — the in-place control then fails closed rather than
 * guessing.
 */
export type MemorySharingPosture = "private" | "consent_required" | null;

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
  sharingPosture,
  sharingBusy,
  sharingError,
  canMutate,
  saving,
  deleting,
  actionError,
  onBack,
  onSharingChange,
  onSharingOpenChange,
  onSave,
  onForget,
  onOpenOwner,
  displayLabel,
  displayValue,
  displayContext,
  hideBack = false,
}: {
  card: PkmMemoryCard;
  sharingState: MemorySharingState;
  sharingPosture: MemorySharingPosture;
  sharingBusy: boolean;
  sharingError: string | null;
  canMutate: boolean;
  saving: boolean;
  deleting: boolean;
  actionError: string | null;
  onBack: () => void;
  onSharingChange: (nextPosture: "private" | "consent_required") => void;
  onSharingOpenChange?: (open: boolean) => void;
  onSave: (nextValue: string) => void;
  onForget: () => void;
  /** Opens the app screen that owns a reserved item (memory_screen_policy). */
  onOpenOwner?: (routePattern: string) => void;
  displayLabel?: string;
  displayValue?: string;
  displayContext?: string;
  hideBack?: boolean;
}) {
  const reservedOwner = card.reservedOwner ?? null;
  const labels = pkmMemoryRowLabels(card);
  const primary = displayLabel ?? labels.primary;
  const secondary = displayValue ?? labels.secondary;
  const fullValue = displayValue ?? card.value;
  const Editor = /[\r\n]/.test(fullValue) ? Textarea : Input;
  const [editOpen, setEditOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [editValue, setEditValue] = useState(fullValue);
  const busy = saving || deleting;

  useEffect(() => {
    if (!saving && !actionError) setEditOpen(false);
  }, [saving, actionError]);

  useEffect(() => {
    setEditValue(fullValue);
  }, [card.id, fullValue]);

  // A new memory starts with its own sharing sheet closed.
  useEffect(() => {
    setSharingOpen(false);
  }, [card.id]);

  function changeSharingOpen(open: boolean) {
    if (sharingBusy) return;
    setSharingOpen(open);
    onSharingOpenChange?.(open);
  }

  return (
    <div className="space-y-7" data-pkm-detail-panel="true" data-pkm-memory-detail="true" data-pkm-location-view={displayValue !== undefined ? "true" : undefined}>
      {!hideBack ? <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex min-h-11 items-center gap-1 text-[15px] font-normal text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Memory
      </button> : null}

      <div className="space-y-2">
        {displayContext ? <p className="text-[13px] leading-5 text-muted-foreground">{displayContext}</p> : null}
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          {primary}
        </h2>
        {secondary ? (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{secondary}</p>
        ) : null}
      </div>

      <SettingsGroup separatorInset testId="memory-detail-meta">
        <SettingsRow
          title="Sharing"
          onClick={() => changeSharingOpen(true)}
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

      {reservedOwner ? (
        <div className="space-y-2" data-testid="memory-detail-reserved">
          {reservedOwner.routePattern && onOpenOwner ? (
            // The same compact row as the chat's offer to this app, so the
            // affordance reads and measures the same wherever it appears.
            <SettingsGroup separatorInset density="compact" testId="memory-detail-owner">
              <SettingsRow
                icon={reservedOwnerGlyph(reservedOwner.ownerFeature)}
                iconTone="capability"
                density="compact"
                title={`Open in ${reservedOwner.appName}`}
                chevron
                onClick={() => onOpenOwner(reservedOwner.routePattern!)}
                testId="memory-detail-open-owner"
              />
            </SettingsGroup>
          ) : null}
          <p className="px-4 text-[13px] leading-5 text-muted-foreground" data-testid="memory-detail-reserved-note">
            {reservedOwner.appName} manages this. Edit or remove it there.
          </p>
        </div>
      ) : (
      <SettingsGroup separatorInset testId="memory-detail-actions">
        <SettingsRow
          title="Edit"
          disabled={!canMutate || busy}
          onClick={() => {
            setEditValue(fullValue);
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
      )}

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
          <Editor
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
              disabled={saving || !editValue.trim() || editValue === fullValue}
              onClick={() => onSave(editValue)}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sharingOpen} onOpenChange={changeSharingOpen}>
        <DialogContent
          showCloseButton={false}
          className="gap-4 sm:max-w-[380px]"
          data-pkm-memory-sharing-sheet="true"
        >
          <DialogHeader>
            <DialogTitle>Sharing</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium text-foreground">{primary}</p>

          {sharingPosture === null ? (
            <p className="text-sm text-muted-foreground">
              Sharing controls for this memory aren’t available right now. Refresh and try again.
            </p>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Ask before sharing</p>
                <p className="text-sm text-muted-foreground">
                  {sharingPosture === "consent_required"
                    ? "One asks for your approval before sharing this with anyone."
                    : "This stays private. One never offers it, even when someone asks."}
                </p>
              </div>
              <Switch
                checked={sharingPosture === "consent_required"}
                disabled={sharingBusy}
                onCheckedChange={(enabled) =>
                  onSharingChange(enabled ? "consent_required" : "private")
                }
                aria-label={
                  sharingPosture === "consent_required"
                    ? "Make this memory private"
                    : "Ask before sharing this memory"
                }
              />
            </div>
          )}

          {sharingBusy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Updating sharing choices…
            </p>
          ) : null}
          {sharingError ? <p className="text-sm text-destructive">{sharingError}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              effect="fade"
              disabled={sharingBusy}
              onClick={() => changeSharingOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
