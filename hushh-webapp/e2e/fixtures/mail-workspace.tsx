import React from 'react';
import { createRoot } from 'react-dom/client';
import { Navbar } from '@/components/navbar';
import GmailReceiptsPage from '@/components/gmail/gmail-receipts-page';
import { AppTopShell } from '@/components/app-ui/top-app-bar';
import { resolveTopShellRouteProfile } from '@/components/app-ui/top-shell-metrics';
import { resolveSignedInShellContentOffset, resolveTopShellGeometryStyle } from '@/components/app-ui/signed-in-shell-content-offset';
import { primeCachedGmailReceipts } from '@/lib/profile/gmail-receipts-cache';
import { publishValidatedAuthSessionOwner } from '@/lib/auth/session-owner';
import { captureReceiptSnapshot } from '@/lib/mail/receipt-snapshot';
import { receiptStoreVersion, writeReceiptSnapshot } from '@/lib/mail/receipt-store';
const syntheticReceipts = ['Amazon','Apple','Myntra','Udemy','Plaid'].map((merchant, i) => ({
 id: i + 1, source_id: `synthetic-source-${i}`, receipt_key: `synthetic-source-${i}`, source_kind: 'gmail_live' as const,
 source_evidence: [], gmail_message_id: `synthetic-message-${i}`, merchant_name: merchant, merchant_domain: `${merchant.toLowerCase()}.com`,
 category: i === 1 ? 'Software & Subscriptions' : 'Shopping', category_confidence: 1,
 transaction_date: 'October 18, 2026', amount: [2450, 199, 1299, 849, 750][i], amount_decimal: ['2450.00','199.00','1299.00','849.00','750.00'][i],
 currency: 'INR', status: 'paid' as const, document_kind: 'receipt' as const, event_type: 'purchase' as const,
}));
publishValidatedAuthSessionOwner('synthetic-owner');
primeCachedGmailReceipts({ userId: 'synthetic-owner', accountKey: 'synthetic-account', response: { items: syntheticReceipts, page: 1, total: syntheticReceipts.length, has_more: false } });
function Fixture() {
 const workspace = (document.documentElement.dataset.workspace || 'overview') as 'overview'|'kyc'|'receipts';
 const style = {...resolveSignedInShellContentOffset({shellVisible:true, routeLayoutMode:'standard'}).style,...resolveTopShellGeometryStyle({hasTabs:false})} as React.CSSProperties;
 return <div data-app-shell-root="true" style={style}>
  <div data-app-scroll-root="true" style={{position:'fixed',inset:0,overflowY:'auto',paddingBottom:'120px'}}>
   <div data-app-shell-top-spacer="true" aria-hidden="true" />
   <div data-app-shell-content="true"><GmailReceiptsPage initialWorkspace={workspace} forceWorkspace={workspace} /></div>
  </div>
  <Navbar/>
  <AppTopShell model={resolveTopShellRouteProfile('/one/gmail').model}/>
 </div>;
}
async function mount() {
 if (document.documentElement.dataset.savedReport === '1') {
  const base = { ...syntheticReceipts[0]!, transaction_date: '2026-10-10', currency: 'USD', amount: 0.1, amount_decimal: '0.10',
   recurrence: 'recurring' as const, identifiers: [{ kind: 'invoice' as const, value: 'INVOICE-1' }] };
  const accounts = [
   { account: 'synthetic-account', items: [base] },
   { account: 'synthetic-other-account', items: [{ ...base, id: 20, source_id: 'forwarded-copy', receipt_key: 'forwarded-copy' },
    { ...base, id: 21, source_id: 'second-charge', receipt_key: 'second-charge', amount: 0.2, amount_decimal: '0.20', identifiers: [{ kind: 'invoice' as const, value: 'INVOICE-2' }] },
    { ...base, id: 22, source_id: 'inr-charge', receipt_key: 'inr-charge', currency: 'INR', amount: 30, amount_decimal: '30.00', recurrence: 'one_time' as const, identifiers: [{ kind: 'invoice' as const, value: 'INVOICE-3' }] }] },
  ];
  for (const { account, items } of accounts) {
   const snapshot = await captureReceiptSnapshot(items, account, { partial: false, truncated: false, source_count: items.length,
    window_from: '2026-10-01', window_to: '2026-11-01', source: 'gmail_live' });
   await writeReceiptSnapshot({ userId: 'synthetic-owner', vaultKey: '12'.repeat(32), vaultOwnerToken: 'synthetic-owner-token' },
    snapshot, await receiptStoreVersion('synthetic-owner', account));
  }
 }
 createRoot(document.getElementById('root')!).render(<Fixture/>);
}
void mount();
