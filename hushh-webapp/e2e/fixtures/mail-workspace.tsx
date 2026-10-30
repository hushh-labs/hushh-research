import React from 'react';
import { createRoot } from 'react-dom/client';
import { Navbar } from '@/components/navbar';
import GmailReceiptsPage from '@/components/gmail/gmail-receipts-page';
import { GmailWorkspaceSkeleton } from '@/components/gmail/gmail-workspace-skeleton';
import { CapabilityCinematicIntroGate } from '@/components/onboarding/setup/capability-cinematic-intro';
import ProfileGmailOAuthReturnPageClient from '@/app/profile/gmail/oauth/return/page-client';
import { AppTopShell } from '@/components/app-ui/top-app-bar';
import { resolveTopShellRouteProfile } from '@/components/app-ui/top-shell-metrics';
import { resolveSignedInShellContentOffset, resolveTopShellGeometryStyle } from '@/components/app-ui/signed-in-shell-content-offset';
import { primeCachedGmailReceipts } from '@/lib/profile/gmail-receipts-cache';
import { captureReceiptSnapshot } from '@/lib/mail/receipt-snapshot';
import { MailReceiptResourceService } from '@/lib/services/mail-receipt-resource-service';
import { publishValidatedAuthSessionPrincipal } from '@/lib/auth/session-owner';
const syntheticReceipts = ['Amazon','Apple','Myntra','Udemy','Plaid'].map((merchant, i) => ({
 id: i + 1, source_id: `synthetic-source-${i}`, receipt_key: `synthetic-source-${i}`, source_kind: 'gmail_live' as const,
 source_evidence: [], gmail_message_id: `synthetic-message-${i}`, merchant_name: merchant, merchant_domain: `${merchant.toLowerCase()}.com`,
 category: i === 1 ? 'Software & Subscriptions' : 'Shopping', category_confidence: 1,
 transaction_date: 'October 18, 2026', amount: document.documentElement.dataset.stress === 'long' && i === 0 ? 2450000000 : [2450, 199, 1299, 849, 750][i], amount_decimal: document.documentElement.dataset.stress === 'long' && i === 0 ? '2450000000.00' : ['2450.00','199.00','1299.00','849.00','750.00'][i],
 currency: 'INR', status: 'paid' as const, document_kind: 'receipt' as const, event_type: 'purchase' as const,
})).map((receipt, i) => document.documentElement.dataset.stress === 'long' && i === 0 ? { ...receipt, merchant_name: 'The Very Long International Merchant and Services Group Limited' } : receipt);
publishValidatedAuthSessionPrincipal({ firebaseUid: 'synthetic-owner', ownerId: 'synthetic-owner', accountGeneration: 0 });
primeCachedGmailReceipts({ userId: 'synthetic-owner', accountKey: 'synthetic-account', response: { items: syntheticReceipts, page: 1, total: syntheticReceipts.length, has_more: false } });
function Fixture() {
 const workspace = (document.documentElement.dataset.workspace || 'overview') as 'overview'|'kyc'|'receipts'|'setup'|'intro'|'skeleton'|'skeleton-hidden'|'callback'|'callback-loading'|'callback-cloud-loading';
 const route = workspace === 'setup' || workspace === 'intro' ? '/one/setup/gmail' : workspace.startsWith('callback') ? '/one/profile/gmail/oauth/return' : '/one/gmail';
 const style = {...resolveSignedInShellContentOffset({shellVisible:true, routeLayoutMode:'standard'}).style,...resolveTopShellGeometryStyle({hasTabs:false})} as React.CSSProperties;
 return <div data-app-shell-root="true" style={style}>
  <div data-app-scroll-root="true" style={{position:'fixed',inset:0,overflowY:'auto',paddingBottom:'120px'}}>
   <div data-app-shell-top-spacer="true" aria-hidden="true" />
   <div data-app-shell-content="true">{workspace === 'skeleton' || workspace === 'skeleton-hidden' ? <GmailWorkspaceSkeleton titleVisuallyHidden={workspace === 'skeleton-hidden'} /> : workspace.startsWith('callback')
    ? <ProfileGmailOAuthReturnPageClient initialCode="" initialState={workspace === 'callback-cloud-loading' ? 'byoc.synthetic' : ''} initialError={workspace === 'callback' ? 'access_denied' : ''} initialErrorDescription={workspace === 'callback' ? 'Google sign-in was cancelled.' : ''} />
    : workspace === 'intro'
    ? <CapabilityCinematicIntroGate capabilityId="gmail"><GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} /></CapabilityCinematicIntroGate>
    : workspace === 'setup'
    ? <GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} />
    : <GmailReceiptsPage initialWorkspace={workspace} forceWorkspace={workspace} />}</div>
  </div>
  <Navbar/>
  <AppTopShell model={resolveTopShellRouteProfile(route).model}/>
 </div>;
}
void captureReceiptSnapshot(syntheticReceipts, 'synthetic-account', {
 partial: false, truncated: false, source_count: syntheticReceipts.length,
 window_from: null, window_to: null, source: 'gmail_live',
}).then(snapshot => {
 MailReceiptResourceService.prime(snapshot);
 createRoot(document.getElementById('root')!).render(<Fixture/>);
});
