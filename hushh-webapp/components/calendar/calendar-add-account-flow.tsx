"use client";

import { useEffect, useRef, useState } from "react";
import { morphyToast } from "@/lib/morphy-ux/morphy";
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

type Account = { account_id: string; google_email?: string | null; connected?: boolean };

/** Owns the add-account steps: permissions first, then Mail for the new account. */
export function useCalendarAddAccountFlow({ identity, accounts, busy, connectNewAccount, allowAccountMail }: {
  identity: symbol;
  accounts: readonly Account[] | undefined;
  busy: boolean;
  connectNewAccount: () => void;
  allowAccountMail: (accountId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<{ accountId: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const before = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => { setOpen(false); setAdded(null); before.current = null; }, [identity]);
  useEffect(() => {
    const known = before.current;
    const account = known ? accounts?.find(item => item.connected && !known.has(item.account_id)) : undefined;
    if (!account) return;
    before.current = null;
    setError(null);
    setAdded({ accountId: account.account_id, email: account.google_email || "This account" });
  }, [accounts]);

  const dialogs = (
    <>
      <CalendarAddAccountPermissions open={open} busy={busy} onCancel={() => setOpen(false)} onContinue={() => {
        // The consent window opens inside this click, so the browser keeps the gesture.
        before.current = new Set(accounts?.map(item => item.account_id) ?? []);
        setOpen(false);
        connectNewAccount();
      }} />
      <CalendarAddedAccountMail account={added} busy={busy} error={error} onSkip={() => setAdded(null)} onAllow={() => {
        if (!added) return;
        setError(null);
        void allowAccountMail(added.accountId).catch(() => false).then(granted => {
          if (granted) { morphyToast.success("Mail allowed for this account."); setAdded(null); }
          else setError("Mail access was not allowed. Try again or skip this step.");
        });
      }} />
    </>
  );
  return { openAddAccount: () => setOpen(true), dialogs };
}
