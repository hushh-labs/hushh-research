import { AppPageShell, AppPageContentRegion } from '@/components/app-ui/app-page-shell';
import { TopShellTabs } from '@/components/app-ui/top-shell-tabs';
import { TOP_SHELL_TAB_REGISTRY } from '@/lib/navigation/top-shell-tabs';
import { LocationPrimaryShareCard } from '@/components/one-location/redesign/location-hub-summary';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppBottomShell } from '@/components/app-ui/app-bottom-shell';
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
// "receipts-ref": a mailbox with recurring bills, five monthly plans and one ordinary purchase, to compare with the
// product reference. data-rise="1" adds a November electricity bill that is 32.7% above its usual amount.
type Row = [merchant: string, date: string, amount: number, detail: string, category: 'Bills' | 'Software & Subscriptions' | 'Food'];
const rise = document.documentElement.dataset.rise === '1';
const referenceRows: Row[] = [
 ...['2026-03-02', '2026-06-02', '2026-09-02', '2026-12-02'].map((d): Row => ['Orbit Mobile', d, 899, 'Mobile recharge', 'Bills']),
 ...['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'].map((d): Row => ['Maple Homes', d, 24000, 'House rent', 'Bills']),
 ...(rise ? [['2026-08-26', 1420], ['2026-09-26', 1470], ['2026-10-26', 1780], ['2026-11-26', 1950]] : [['2026-09-26', 1420], ['2026-10-26', 1470], ['2026-11-26', 1780]])
  .map(([d, a]): Row => ['Electricity bill', d as string, a as number, 'Electricity', 'Bills']),
 ...['2026-08-30', '2026-09-30', '2026-10-30', '2026-11-30'].map((d): Row => ['Wi-Fi', d, 799, 'Internet', 'Bills']),
 ...['2026-08-30', '2026-09-30', '2026-10-30', '2026-11-30'].map((d): Row => ['Cable TV', d, 499, 'Cable', 'Bills']),
 ...['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30'].map((d): Row => ['Monthly deposit', d, 5000, 'Deposit', 'Bills']),
 ...[['Alpha TV', 299], ['Beta Stream', 399], ['Gamma Play', 199], ['Delta Sports', 249], ['Epsilon Kids', 249]].flatMap(([m, a]) =>
  ['2026-08-04', '2026-09-04', '2026-10-04', '2026-11-04'].map((d): Row => [m as string, d, a as number, 'Streaming plan', 'Software & Subscriptions'])),
 ['Corner Cafe', '2026-11-20', 450, 'Lunch', 'Food'],
];
// data-notice="1": saved receipts carry sealed routing keys, as real ones do, so One's mailbox check can be asked about them.
const sealedKeys = document.documentElement.dataset.notice === '1';
const sealedKey = (index: number) => `grs1_reference_source_${index}`.padEnd(48, 'x');
const referenceReceipts = referenceRows.map(([merchant, date, amount, detail, category], index) => ({
 id: 100 + index, source_id: `reference-source-${index}`, receipt_key: `reference-source-${index}`, ...(sealedKeys ? { durable_source_ref: sealedKey(index) } : {}), source_kind: 'gmail_live' as const,
 source_evidence: [], gmail_message_id: `reference-message-${index}`, merchant_name: merchant, merchant_domain: `${merchant.toLowerCase().replace(/[^a-z]/g, '')}.example`,
 category, category_confidence: 1, transaction_date: date, amount, currency: 'INR', short_detail: detail,
 status: 'paid' as const, document_kind: 'receipt' as const, event_type: 'purchase' as const, recurrence: category === 'Food' ? 'one_time' as const : 'recurring' as const,
}));
const syntheticReceipts = document.documentElement.dataset.stress === 'receipts-ref' ? referenceReceipts : ['Amazon','Apple','Myntra','Udemy','Plaid'].map((merchant, i) => ({
 id: i + 1, source_id: `synthetic-source-${i}`, receipt_key: `synthetic-source-${i}`, source_kind: 'gmail_live' as const,
 source_evidence: [], gmail_message_id: `synthetic-message-${i}`, merchant_name: merchant, merchant_domain: `${merchant.toLowerCase()}.com`,
 category: document.documentElement.dataset.stress === 'categories'
  ? ['Other', 'Shopping', 'Cloud & Infra', 'Software & Subscriptions', 'Travel'][i]
  : i === 1 ? 'Software & Subscriptions' : 'Shopping', category_confidence: 1,
 transaction_date: 'October 18, 2026', amount: document.documentElement.dataset.stress === 'long' && i === 0 ? 2450000000 : [2450, 199, 1299, 849, 750][i], amount_decimal: document.documentElement.dataset.stress === 'long' && i === 0 ? '2450000000.00' : ['2450.00','199.00','1299.00','849.00','750.00'][i],
 currency: 'INR', status: 'paid' as const, document_kind: 'receipt' as const, event_type: 'purchase' as const,
})).map((receipt, i) => document.documentElement.dataset.stress === 'long' && i === 0 ? { ...receipt, merchant_name: 'The Very Long International Merchant and Services Group Limited' } : receipt);
publishValidatedAuthSessionPrincipal({ firebaseUid: 'synthetic-owner', ownerId: 'synthetic-owner', accountGeneration: 0 });
primeCachedGmailReceipts({ userId: 'synthetic-owner', accountKey: 'synthetic-account', response: { items: syntheticReceipts, page: 1, total: syntheticReceipts.length, has_more: false } });
function Fixture() {
 const workspace = (document.documentElement.dataset.workspace || 'overview') as 'overview'|'kyc'|'receipts'|'setup'|'intro'|'skeleton'|'skeleton-hidden'|'callback'|'callback-loading'|'callback-cloud-loading';
 const reference = document.documentElement.dataset.reference === 'location';
 const route = reference ? '/one/location' : workspace === 'setup' || workspace === 'intro' ? '/one/setup/gmail' : workspace.startsWith('callback') ? '/one/profile/gmail/oauth/return' : '/one/gmail';
 const style = {'--bottom-chrome-stack-height':'var(--app-bottom-shell-height, calc(var(--app-bottom-inset) + var(--kai-command-fixed-ui)))', ...resolveSignedInShellContentOffset({shellVisible:true, routeLayoutMode:'standard'}).style,...resolveTopShellGeometryStyle({hasTabs:false})} as React.CSSProperties;
 return <div data-app-shell-root="true" style={style}>
  <div data-app-scroll-root="true" style={{position:'fixed',inset:0,overflowY:'auto',paddingBottom:'var(--app-bottom-content-clearance)'}}>
   <div data-app-shell-top-spacer="true" aria-hidden="true" />
   <div data-app-shell-content="true">{reference ? <AppPageShell width="reading" fitContent data-location-page headerContentSpacing="compact">
     <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden"><TopShellTabs tabSet={{...TOP_SHELL_TAB_REGISTRY.location, activeValue: 'now'}}/><LocationPrimaryShareCard onClick={() => {}}/></AppPageContentRegion>
    </AppPageShell> : workspace === 'skeleton' || workspace === 'skeleton-hidden' ? <GmailWorkspaceSkeleton titleVisuallyHidden={workspace === 'skeleton-hidden'} /> : workspace.startsWith('callback')
    ? <ProfileGmailOAuthReturnPageClient initialCode="" initialState={workspace === 'callback-cloud-loading' ? 'byoc.synthetic' : ''} initialError={workspace === 'callback' ? 'access_denied' : ''} initialErrorDescription={workspace === 'callback' ? 'Google sign-in was cancelled.' : ''} />
    : workspace === 'intro'
    ? <CapabilityCinematicIntroGate capabilityId="gmail"><GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} /></CapabilityCinematicIntroGate>
    : workspace === 'setup'
    ? <GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} />
    : <GmailReceiptsPage initialWorkspace={workspace} forceWorkspace={workspace} />}</div>
  </div>
  {document.documentElement.dataset.layoutProof ? <AppBottomShell model={{navigationHidden:false}}/> : <Navbar/>}
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
