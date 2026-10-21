import React from 'react';
import { createRoot } from 'react-dom/client';
import { Navbar } from '@/components/navbar';
import GmailReceiptsPage from '@/components/gmail/gmail-receipts-page';
import { AppTopShell } from '@/components/app-ui/top-app-bar';
import { resolveTopShellRouteProfile } from '@/components/app-ui/top-shell-metrics';
import { resolveSignedInShellContentOffset, resolveTopShellGeometryStyle } from '@/components/app-ui/signed-in-shell-content-offset';
import { primeCachedGmailReceipts } from '@/lib/profile/gmail-receipts-cache';
import { publishValidatedAuthSessionOwner } from '@/lib/auth/session-owner';
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
createRoot(document.getElementById('root')!).render(<Fixture/>);
