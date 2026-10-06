"use client";

import { Check, Copy, KycAgentIcon, Lock } from "@/components/icons";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

/**
 * A quiet text action. It deliberately has no hover or press wash: the shared
 * Button's state layer drew a grey pill behind these two links, which read as
 * a second, unrelated control.
 */
const TEXT_ACTION_CLASSNAME =
  "inline-flex min-h-11 items-center bg-transparent px-0 text-[14.45px] font-medium leading-[18.7px] text-[color:var(--app-accent)] outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] active:opacity-60 disabled:pointer-events-none disabled:opacity-50";

/**
 * The paste form behind the KYC intro card. It owns layout only: the draft,
 * the save and the prompt copy all stay with the caller.
 */
export function KycPasteDetailsDialog({
  open,
  onOpenChange,
  details,
  onDetailsChange,
  saving,
  copied,
  onCopyPrompt,
  onSave,
  onSkip,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: string;
  onDetailsChange: (details: string) => void;
  saving: boolean;
  copied: boolean;
  onCopyPrompt: () => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        srDescription="Paste your profile details so One can prepare future KYC replies."
        className="gap-0 p-6 text-center sm:max-w-xl sm:p-8"
      >
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border border-[color:var(--app-accent-tint)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)] shadow-sm sm:size-14">
          <KycAgentIcon className="size-6 sm:size-7" />
        </div>
        <DialogTitle className="px-4 text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl">
          Paste your profile details
        </DialogTitle>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Provide your information so One can securely parse and automate your
          KYC documents.
        </p>
        <Textarea
          value={details}
          onChange={(event) => onDetailsChange(event.target.value)}
          placeholder="Paste your profile details here…"
          className="mt-6 min-h-36 resize-none rounded-2xl border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-4 text-left shadow-none transition-[border-color,box-shadow] focus-visible:border-[color:var(--app-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]/20"
          aria-label="KYC details"
          disabled={saving}
        />
        <div className="mt-3 flex flex-col items-start px-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2">
            <button
              type="button"
              onClick={onCopyPrompt}
              aria-label="Copy prompt to clipboard"
              className={TEXT_ACTION_CLASSNAME}
            >
              {copied ? (
                <Check aria-hidden="true" className="mr-2 size-[17px] shrink-0 text-emerald-500" />
              ) : (
                <Copy aria-hidden="true" className="mr-2 size-[17px] shrink-0" />
              )}
              {copied ? "Copied" : "Copy AI prompt"}
            </button>
            <span className="text-xs text-muted-foreground">· Optional</span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Use in your AI app. Then paste the reply here.
          </p>
        </div>
        <div className="mx-auto mt-5 flex w-full max-w-[244px] flex-col items-center gap-1">
          <Button
            type="button"
            size="prominent"
            onClick={onSave}
            disabled={saving || !details.trim()}
            className="w-full justify-center"
          >
            {saving ? "Saving…" : "Save profile"}
          </Button>
          <button
            type="button"
            onClick={onSkip}
            disabled={saving}
            className={cn(TEXT_ACTION_CLASSNAME, "px-4 text-[15px] font-normal")}
          >
            Skip for now
          </button>
        </div>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5 shrink-0 text-emerald-500" />
          Encrypted with 256-bit AES · Stored in your private vault
        </p>
      </DialogContent>
    </Dialog>
  );
}

