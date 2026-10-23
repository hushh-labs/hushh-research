"use client";
import { MailConnectedAccount, MailOverview } from "./mail-overview";
import { MailSavedReceiptReport } from "./mail-saved-receipt-report";
import type { ReceiptStoreSession } from "@/lib/mail/receipt-store";
import { MailGoogleAccounts } from './mail-google-accounts';
import type { GoogleConnectorTransitionReview } from '@/lib/one/google-native-connect';

type Props = Parameters<typeof MailOverview>[0] & {
  connected: boolean; busy: boolean; onReconnect: () => void; onDisconnect: () => void;
  session: ReceiptStoreSession | null; account: string | null; email?: string | null;
  receiptRevision: string; active: boolean;
  confirmTransition?: (terms: GoogleConnectorTransitionReview) => Promise<boolean>;
  onAccountsChanged?: () => void;
};

export function MailOverviewWorkspace({ connected, busy, onReconnect, onDisconnect, session, account, email, receiptRevision, active, confirmTransition, onAccountsChanged, ...overview }: Props) {
  const accountCard = connected ? <MailConnectedAccount email={email} busy={busy} onReconnect={onReconnect} onDisconnect={onDisconnect} /> : null;
  const report = session ? <MailSavedReceiptReport session={session} activeAccount={account} activeEmail={email} receiptRevision={receiptRevision} enabled={active} /> : null;
  return <>
    {session && confirmTransition && onAccountsChanged ? <MailGoogleAccounts key={session.userId} session={session} enabled={active} fallback={accountCard} fallbackReport={report} confirmTransition={confirmTransition} onChanged={onAccountsChanged} /> : <>{accountCard}{report}</>}
    {connected ? <MailOverview {...overview} /> : null}
  </>;
}
