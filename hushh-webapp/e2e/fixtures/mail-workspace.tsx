import { AppPageShell, AppPageContentRegion } from '@/components/app-ui/app-page-shell';
import { TopShellTabs } from '@/components/app-ui/top-shell-tabs';
import { TOP_SHELL_TAB_REGISTRY } from '@/lib/navigation/top-shell-tabs';
import { LocationPrimaryShareCard } from '@/components/one-location/redesign/location-hub-summary';
import React from 'react';
import { MailWhySheet } from '../../components/gmail/mail-brief-why';
import { createRoot } from 'react-dom/client';
import { Navbar } from '@/components/navbar';
import { AppBottomShell } from '@/components/app-ui/app-bottom-shell';
import { AgentDockProvider } from '@/components/agent/agent-dock';
import { LocationCommandProvider } from '@/components/agent/location-command-provider';
import { applyNoticeCheck, loadTracking, saveTracking } from '@/lib/mail/receipt-tracking';
import { parseNoticeResponse } from '@/lib/mail/receipt-notice';
import { useOneConversationSession } from '@/lib/agent/one-conversation-session';
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
 const workspace = (document.documentElement.dataset.workspace || 'overview') as 'overview'|'followups'|'kyc'|'receipts'|'setup'|'intro'|'skeleton'|'skeleton-hidden'|'callback'|'callback-loading'|'callback-cloud-loading';
 const reference = document.documentElement.dataset.reference === 'location';
 const route = reference ? '/one/location' : workspace === 'setup' || workspace === 'intro' ? '/one/setup/gmail' : workspace.startsWith('callback') ? '/one/profile/gmail/oauth/return' : workspace === 'kyc' ? '/one/kyc' : '/one/gmail';
 const style = {...resolveSignedInShellContentOffset({shellVisible:true, routeLayoutMode:'standard'}).style,...resolveTopShellGeometryStyle({hasTabs:false})} as React.CSSProperties;
 return <div data-app-shell-root="true" style={style}>
  <div data-app-scroll-root="true" style={{position:'fixed',inset:0,overflowY:'auto',paddingBottom:'120px'}}>
   <div data-app-shell-top-spacer="true" aria-hidden="true" />
   <div data-app-shell-content="true">{reference ? <AppPageShell width="reading" fitContent data-location-page headerContentSpacing="compact">
     <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden"><TopShellTabs tabSet={{...TOP_SHELL_TAB_REGISTRY.location, activeValue: 'now'}}/><LocationPrimaryShareCard onClick={() => {}}/></AppPageContentRegion>
    </AppPageShell> : workspace === 'skeleton' || workspace === 'skeleton-hidden' ? <GmailWorkspaceSkeleton titleVisuallyHidden={workspace === 'skeleton-hidden'} /> : workspace.startsWith('callback')
    ? <ProfileGmailOAuthReturnPageClient initialCode="" initialState={workspace === 'callback-cloud-loading' ? 'byoc.synthetic' : ''} initialError={workspace === 'callback' ? 'access_denied' : ''} initialErrorDescription={workspace === 'callback' ? 'Google sign-in was cancelled.' : ''} />
    : workspace === 'intro'
    ? <CapabilityCinematicIntroGate capabilityId="gmail"><GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} /></CapabilityCinematicIntroGate>
    : workspace === 'setup'
    ? <GmailReceiptsPage journeyVariant="onboarding" onFinishSetup={() => {}} onSkipSetup={() => {}} />
    : workspace === 'kyc'
    ? <GmailReceiptsPage surface="kyc" />
    : <GmailReceiptsPage initialWorkspace={workspace} forceWorkspace={workspace} />}</div>
  </div>
  {shell ? <AppBottomShell model={{ navigationHidden: false, agentBarHidden: false, includeComposerHeight: false }} /> : <Navbar/>}
  <AppTopShell model={resolveTopShellRouteProfile(route).model}/>
 </div>;
}
// data-shell="1": the production bottom chrome, "Talk to One" bar and navigation pill included, as providers.tsx mounts it.
const shell = document.documentElement.dataset.shell === '1';
// Lets a test read what the Overview handed to One's reviewed draft card, and that nothing else happened.
(window as unknown as { __mailHandoff: () => unknown }).__mailHandoff = () => useOneConversationSession.getState().pendingHandoff?.mailCompose ?? null;
// data-brief-rise="1": Receipts already holds a saved price-rise finding from an earlier mailbox check, so the Overview can list it.
const sealed = (seed: string) => `grs1_${seed.padEnd(44, 'x')}`;
async function seedPriceRise() {
 const session = { userId: 'synthetic-owner', vaultKey: '12'.repeat(32), vaultOwnerToken: 'synthetic-owner-token' };
 const loaded = await loadTracking(session, 'synthetic-account');
 const check = parseNoticeResponse({
  account_key: 'synthetic-account', generated_at: new Date().toISOString(), model: 'fixture', coverage: { providers: 1, messages: 4 }, resolved: [], cancellations: [], none_reason: '',
  findings: [{
   id: 'nf_price_fixture', kind: 'price_rise', headline: 'Your plan is going up', reason: 'The provider announced a new price for your renewal.', strength: 'clear',
   provider: null, action: { id: 'review_bill', label: 'Review bill' }, attribution: null, score: 60, generated_at: new Date().toISOString(),
   evidence: [
    { evidence_id: 'ev_ann_fixture1', open_key: sealed('announce'), role: 'announcement', quote: 'your new price will be ₹1,800', on: '2026-11-10', subject: 'Price change', from: 'Provider', domain: 'provider.example' },
    { evidence_id: 'ev_paid_fixture', open_key: sealed('paid'), role: 'paid', quote: 'Total ₹1,200.00 paid', on: '2026-11-02', subject: 'Your payment receipt', from: 'Provider', domain: 'provider.example' },
   ],
   plans: [], facts: { currency: 'INR', last_paid_minor: 120000, new_minor: 180000, new_is_announced: true, base_minor: 120000, base_kind: 'median_of_last_three', percent: '50.0', effective_on: '2026-11-26' },
  }],
 }, 'synthetic-account');
 let n = 0;
 await saveTracking(session, 'synthetic-account', applyNoticeCheck(loaded.doc, check, 'd1_fixture', { now: new Date(), id: () => `fx${++n}` }), loaded.version);
}
void captureReceiptSnapshot(syntheticReceipts, 'synthetic-account', {
 partial: false, truncated: false, source_count: syntheticReceipts.length,
 window_from: null, window_to: null, source: 'gmail_live',
}).then(async snapshot => {
 MailReceiptResourceService.prime(snapshot);
 if (document.documentElement.dataset.briefRise === '1') await seedPriceRise();
 const root = createRoot(document.getElementById('root')!);
 if (document.documentElement.dataset.summaryReader) {
   root.render(<MailWhySheet target={{ title: "Review", openFirst: true, evidence: [{ sourceId: "fixture", from: "Reviewer", on: "", direction: "received", quote: "" }] }}
     expectedAccount="synthetic-account" vaultOwnerToken={null} onClose={() => {}} onReconnect={() => {}} onUnlock={() => {}}
     readMessage={async (sourceId, _signal, original) => ({
       sourceId, subject: "Review", sender: "Reviewer", receivedAt: null, unread: false, bodyTruncated: true,
       body: original ? "Original excerpt with the review requirements." : "",
       summary: original ? undefined : "Review is blocked.\n• Upload A by June 2.\n• Ask Sam for B.",
     })} />);
   return;
 }
 root.render(shell ? <LocationCommandProvider enabled={false}><AgentDockProvider><Fixture/></AgentDockProvider></LocationCommandProvider> : <Fixture/>);
});
