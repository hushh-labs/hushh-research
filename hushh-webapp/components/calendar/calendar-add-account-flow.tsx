"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CalendarSetupPermissions } from "./calendar-connect-hero";
import presentationStyles from "./calendar-presentation.module.css";

/**
 * Adding an account follows first-time setup: every permission is named before
 * Google opens, then Mail is offered for the new account, so nothing asks again
 * later from Insights or a conflict.
 */
export function CalendarAddAccountPermissions({ open, busy, onContinue, onCancel }: {
  open: boolean;
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <AlertDialogContent size="sm" className={presentationStyles.portal} data-profile-type-scale="calendar" data-testid="calendar-add-account-permissions">
        <AlertDialogHeader className="text-center">
          <AlertDialogTitle>Add a Google account</AlertDialogTitle>
          <AlertDialogDescription>Google asks once, so this account works everywhere in Calendar.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex justify-center"><CalendarSetupPermissions /></div>
        <AlertDialogFooter className="flex-row justify-center gap-2">
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={busy} onClick={onContinue}>Continue to Google</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function CalendarAddedAccountMail({ account, busy, error, onAllow, onSkip }: {
  account: { accountId: string; email: string } | null;
  busy: boolean;
  error: string | null;
  onAllow: () => void;
  onSkip: () => void;
}) {
  return (
    <AlertDialog open={Boolean(account)} onOpenChange={next => { if (!next && !busy) onSkip(); }}>
      <AlertDialogContent size="sm" className={presentationStyles.portal} data-profile-type-scale="calendar" data-testid="calendar-added-account-mail">
        <AlertDialogHeader className="text-center">
          <AlertDialogTitle>Allow Mail for this account?</AlertDialogTitle>
          <AlertDialogDescription>
            {account?.email} is connected. Allow Mail so One can find meeting requests and reminders for it. Nothing is sent without your approval.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-center text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter className="flex-row justify-center gap-2">
          <AlertDialogCancel disabled={busy}>Not now</AlertDialogCancel>
          <Button type="button" disabled={busy} onClick={onAllow}>Allow Mail</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
