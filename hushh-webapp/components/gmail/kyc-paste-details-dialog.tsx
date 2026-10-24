"use client";

import { Copy, Lock } from "@/components/icons";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import mailStyles from "./mail-workspace.module.css";
import { MailActionButton as Button } from "./mail-action-button";
import { cn } from "@/lib/utils";
import type { RefObject } from "react";

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
  returnFocusRef,
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
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        srDescription="Paste your profile details so One can prepare future KYC replies."
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
        className={`${mailStyles.typography} ${mailStyles.portal} gap-0 p-6 text-center sm:max-w-xl sm:p-8`}
      >
        <DialogTitle className="ui-text-navigation-title px-8 text-foreground">
          Paste your profile details
        </DialogTitle>
        <p className="mx-auto mt-2 max-w-md text-sm leading-5 text-muted-foreground">
          Provide your information so One can securely parse and automate your
          KYC documents.
        </p>
        <Textarea
          value={details}
          onChange={(event) => onDetailsChange(event.target.value)}
          placeholder="Paste your profile details here…"
          className="ui-text-input-value mt-6 min-h-36 resize-none rounded-2xl border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] p-4 text-left shadow-none"
          aria-label="KYC details"
          disabled={saving}
        />
        <div className="mt-3 flex flex-col items-start px-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2">
            <button
              type="button"
              onClick={onCopyPrompt}
              aria-label="Copy prompt to clipboard"
              className={mailStyles.utilityAction}
            >
              <Copy aria-hidden="true" className="mr-2 size-[17px] shrink-0" />
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
            aria-busy={saving}
            className={cn(mailStyles.wideAction, "w-full justify-center")}
          >
            Save profile
          </Button>
          <button
            type="button"
            onClick={onSkip}
            disabled={saving}
            className={cn(mailStyles.utilityAction, "px-4")}
          >
            Skip for now
          </button>
        </div>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5 shrink-0" />
          Encrypted with 256-bit AES · Stored in your private vault
        </p>
      </DialogContent>
    </Dialog>
  );
}
