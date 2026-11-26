import { createContext } from 'react';
export const usePathname = () => document.documentElement.dataset.workspace === 'setup' ? '/one/setup/gmail' : document.documentElement.dataset.workspace?.startsWith('callback') ? '/one/profile/gmail/oauth/return' : document.documentElement.dataset.workspace === 'kyc' ? '/one/kyc' : '/one/gmail';
const params = new URLSearchParams();
export const useSearchParams = () => params;
const router = { push() {}, replace() {}, prefetch() {} };
export const useRouter = () => router;
const user = { uid: 'synthetic-owner', displayName: 'Alex Morgan', email: 'alex@example.com', getIdToken: async () => 'synthetic-id-token' };
export const useAuth = () => ({ user, userId: user.uid, loading: document.documentElement.dataset.workspace === 'callback-loading' || document.documentElement.dataset.workspace === 'callback-cloud-loading', isAuthenticated: true });
export const useRequireAuth = useAuth;
const vault = { vaultKey: '12'.repeat(32), vaultOwnerToken: 'synthetic-owner-token', isVaultUnlocked: true };
export const VaultContext = createContext(vault);
export const useVault = () => vault;
export const useEffectiveAvatarUrl = () => null;
export const usePersonaState = () => ({ activePersona: 'investor', riaCapability: 'disabled', riaEntryRoute: '/ria', switchPersona() {} });
export const useNativePresentationRegions = () => {};
export const subscribeNativeShellInset = () => () => {};
export const VaultService = { peekVaultPresence: () => true, checkVault: async () => true };
export const DELETE_ACCOUNT_DIALOG_DESCRIPTION = 'Delete your account';
export const DELETE_ACCOUNT_DIALOG_TITLE = 'Delete account';
export const accountDeletionErrorMessage = () => 'Unavailable in screenshot fixture';
export const executeVerifiedAccountDeletion = async () => { throw new Error('Unavailable in fixture'); };
export const isHandledAccountDeletionOutcome = () => false;
export const resolveDeleteAccountAuth = async () => { throw new Error('Unavailable in fixture'); };
export const usePublishVoiceSurfaceMetadata = () => {};
export const useVoiceSurfaceControlTracking = () => ({ activeControlId: null, lastInteractedControlId: null });
export const useLocalOnboardingActionHandler = () => {};
// The production bottom shell (data-shell="1") also reads these native-only helpers; on the web they do nothing.
export const hasMountedLocalOnboardingHandler = () => false;
export const nativePresentationAdmission = () => ({});
export const syncNativePresentationRegions = async () => true;
export const setNativeDockPresentationFrame = () => {};
export const useNativePresentationRegionRevision = () => 0;
export const useLocalOnboardingHandlerRevision = () => 0;
export const resolveLocalOnboardingHandler = () => null;
export const waitForLocalOnboardingHandler = async () => null;
export const canonicalActionBinding = (...args: unknown[]) => args;
export const prepareLocalOnboardingAction = async () => null;
export const normalizeNativeBackendUrl = (raw: string) => raw;
export const HushhAuth = {};
export const VaultUnlockDialog = () => null;
const syntheticEmail = document.documentElement.dataset.stress === 'long' ? 'alexander.morgan.with.a.very.long.name@international-research-and-services.example' : 'neha@hushh.ai';
const gmail = {
 status: { connected: true, configured: true, google_sub: 'synthetic-account', google_email: syntheticEmail, account_email: syntheticEmail, email: syntheticEmail, receipt_sync_available: true, connection_state: 'connected', last_sync_status: 'completed', last_sync_at: '2026-10-21T12:00:00Z' },
 loadingStatus: false, statusError: null, syncRun: null, sync: async () => {}, refreshStatus: async () => {},
 presentation: { isConnected: true, state: 'connected', badgeLabel: 'Connected' },
};
export const useGmailConnectorStatus = () => document.documentElement.dataset.connection === 'disconnected'
 ? { ...gmail, status: { ...gmail.status, connected: false, google_sub: null, google_email: null, account_email: null, email: null }, presentation: { isConnected: false, state: 'disconnected', badgeLabel: 'Disconnected' } }
 : document.documentElement.dataset.updates === 'disabled'
  ? { ...gmail, status: { ...gmail.status, receipt_sync_available: false } }
  : gmail;
export const PreVaultUserStateService = { getCachedBootstrapState: () => ({ onboarding_completed: true }), getCached: () => ({}), get: async () => ({}), refresh: async () => ({}), getBootstrapState: async () => ({}), bootstrapState: async () => null };
export const beginGmailOAuthCompletion = () => {};
export const failGmailOAuthCompletion = () => {};
export const primeConnectorStatus = () => {};
export const KycIdentityProfilePkmService = { hasCompletedIntake: async () => document.documentElement.dataset.kycLoading === '1' ? new Promise<boolean>(() => {}) : document.documentElement.dataset.queue === '1' };
const syntheticRequest = {
 workflow_id: 'synthetic-workflow', status: 'detected', gmail_thread_id: 'synthetic-thread',
 received_at: '2026-10-18T12:00:00Z', classification_confidence: 0.92,
 requested_field_labels: ['Postal code'],
 candidate_scopes: [{ scope: 'attr.identity.address.postal_code', domain: 'identity', label: 'Postal code', segment_ids: ['address'] }],
 attachment_review_required: false,
};
export const GmailInformationRequestsService = {
 getPreference: async () => ({ user_id: user.uid, monitoring_enabled: document.documentElement.dataset.queue === '1', retention: 'metadata_only', disclosure: 'Only new inbox messages are checked.' }),
 list: async (input?: { view?: string }) => ({ workflows: document.documentElement.dataset.queue === '1' && input?.view !== 'activity' ? [syntheticRequest] : [], next_offset: null, total_count: document.documentElement.dataset.queue === '1' && input?.view !== 'activity' ? 1 : 0 }),
 scanStream: async () => ({ accepted: true, scanned_count: 0, unchanged_count: 0, matched_count: 0, failed_count: 0, workflow_ids: [] }),
};
// Synthetic Overview backend. Test-only: nothing here is a real mailbox, and the
// scenario is chosen per page with data-overview.
const overviewId = (name: string) => `ms1.${name.padEnd(24, 'x')}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const overviewRows = [
 { name: 'priya', subject: 'Q4 planning notes', sender: 'Priya Sharma', preview: 'Thanks for sending the draft over. A few comments on the revenue section before we circulate it to the wider team.', at: 12, unread: true },
 { name: 'bank', subject: 'Your October statement is ready', sender: 'Northwind Bank', preview: 'Your statement for October is now available to view in your account.', at: 95, unread: true },
 { name: 'inv1', subject: 'Invoice 2041', sender: 'Studio Ledger', preview: 'Attached is the invoice for the November retainer. Payment is due in fifteen days.', at: 60 * 26, unread: false },
 { name: 'inv2', subject: 'Invoice 2041', sender: 'Studio Ledger Billing', preview: 'A correction to the invoice above: the VAT line was missing.', at: 60 * 27, unread: false },
 { name: 'nosubject', subject: null, sender: 'Arjun Mehta', preview: null, at: 60 * 50, unread: false },
 { name: 'long', subject: 'Re: Re: Fwd: Quarterly review of the international research partnerships, vendor onboarding, and the revised travel policy for the winter offsite', sender: 'Alexander Morgan-Whitfield-Hargreaves', preview: 'Please see the attached agenda and let me know whether the second session can move to the afternoon.', at: 60 * 72, unread: false },
 { name: 'm7', subject: 'Lunch on Friday?', sender: 'Meera Iyer', preview: 'Are you free at 1 for the new place on the corner?', at: 60 * 90, unread: false },
 { name: 'm8', subject: 'Welcome to the team', sender: 'People Operations', preview: 'We are delighted to have you with us. Your first week schedule is attached.', at: 60 * 120, unread: false },
];
const overviewRow = (row: (typeof overviewRows)[number]) => ({
 source_id: overviewId(row.name), subject: row.subject, sender: row.sender, preview: row.preview, received_at: minutesAgo(row.at), unread: row.unread,
});
const overviewPage = (kind: 'recent' | 'search', items: ReturnType<typeof overviewRow>[], more: boolean) => ({
 account: 'synthetic-account',
 scope: kind === 'recent' ? { kind, mailbox: 'inbox', label: 'Inbox' } : { kind, mailbox: 'all_mail', label: 'All mail (Spam and Trash excluded)' },
 items, coverage: { requested: items.length, returned: items.length, more_available: more, cap: 25 },
});
const overviewJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Synthetic Overview brief. The people, dates and amounts mirror the approved reference; they live in this
// fixture only. Scenario per page with data-brief: reference (default), one, many, empty, failed, slow.
const briefMail: Record<string, { subject: string; sender: string; at: number; body: string }> = {
 iit: { subject: 'Signed document', sender: 'Prof. Sen', at: 60 * 24 * 7, body: 'Hello,\n\nThank you for the call. I will send the signed document by 20 Nov. Regards, Prof. Sen' },
 maya: { subject: 'Brand assets', sender: 'Maya Rao', at: 60 * 24 * 5, body: 'Hi,\n\nI will send the final brand assets by 21 Nov. Thanks, Maya' },
 morgan: { subject: 'Payment terms', sender: 'Morgan Lee', at: 60 * 24 * 3, body: 'Hello,\n\nPlease choose a payment term of 30 to 45 days so we can finalise the contract. Morgan' },
 sam: { subject: 'Venue booking', sender: 'Sam Iyer', at: 60 * 24 * 2, body: 'Hi,\n\nCould you confirm the venue booking by 28 Nov? Thanks, Sam' },
 ours: { subject: 'Proposal', sender: 'You', at: 60 * 24 * 4, body: 'Hi Priya,\n\nAttached is our proposal for the project scope.\n\nNeha' },
 priya: { subject: 'Re: Proposal', sender: 'Priya Nair', at: 60 * 24 * 3, body: 'Hi,\n\nApproved. Scope and ₹2.4 lakh budget confirmed. Thanks, Priya' },
 sent: { subject: 'Pricing sheet', sender: 'You', at: 60 * 24 * 4, body: 'Hi Priya,\n\nAttached is the approved pricing sheet.\n\nNeha' },
};
const briefEvidence = (name: string, direction: 'received' | 'sent', quote: string, on: string) => ({
 source_id: overviewId(name), from: direction === 'sent' ? 'You' : briefMail[name]!.sender, on, direction, quote,
});
const briefAttention = (all: boolean) => {
 const items = [
  { id: 'att_iit', kind: 'follow_up', title: 'Get the signed document', reason: 'Prof. Sen said they would send it by 20 Nov and it has not arrived.', context: 'IIT KGP', person: 'Prof. Sen',
    due: { date: '2026-11-20', role: 'promised', label: 'Promised 20 November' }, term: null,
    action: { kind: 'draft_followup', source_id: overviewId('iit'), draft: 'Could you send the signed document when you can? Thank you.' },
    evidence: [briefEvidence('iit', 'received', 'I will send the signed document by 20 Nov', '2026-11-19')] },
  { id: 'att_maya', kind: 'follow_up', title: 'Get the final brand assets', reason: 'Maya said she would send them by 21 Nov.', context: null, person: 'Maya Rao',
    due: { date: '2026-11-21', role: 'promised', label: 'Promised 21 November' }, term: null,
    action: { kind: 'draft_followup', source_id: overviewId('maya'), draft: null },
    evidence: [briefEvidence('maya', 'received', 'I will send the final brand assets by 21 Nov', '2026-11-21')] },
  { id: 'att_morgan', kind: 'reply', title: 'Choose the payment term', reason: 'Morgan needs a payment term from you.', context: null, person: 'Morgan Lee',
    due: null, term: '30 to 45 days',
    action: { kind: 'draft_reply', source_id: overviewId('morgan'), draft: null },
    evidence: [briefEvidence('morgan', 'received', 'choose a payment term of 30 to 45 days', '2026-11-23')] },
  { id: 'att_sam', kind: 'reply', title: 'Confirm the venue booking', reason: 'Sam asked you to confirm the venue.', context: null, person: 'Sam Iyer',
    due: { date: '2026-11-28', role: 'needed_by', label: 'Needed by 28 November' }, term: null,
    action: { kind: 'draft_reply', source_id: overviewId('sam'), draft: null },
    evidence: [briefEvidence('sam', 'received', 'confirm the venue booking by 28 Nov', '2026-11-24')] },
 ];
 const more = [...items, ...[5, 6].map(n => ({ ...items[3]!, id: `att_extra_${n}`, title: `Reply to request ${n}` }))];
 return all ? more : items;
};
const briefScenario = () => document.documentElement.dataset.brief || 'reference';
const briefApi = async (path: string) => {
 const scenario = briefScenario();
 if (scenario === 'slow') return new Promise<Response>(() => {});
 const account = 'synthetic-account';
 if (path.endsWith('/brief')) {
  if (scenario === 'failed') return overviewJson({ detail: { code: 'BRIEF_UNAVAILABLE', message: 'One can’t check your mail right now. Try again.' } }, 503);
  const empty = scenario === 'empty';
  return overviewJson({
   account, generated_at: new Date().toISOString(), coverage: { messages: empty ? 14 : 18, window_days: 21, may_be_partial: false },
   attention: empty ? [] : scenario === 'one' ? briefAttention(false).slice(0, 1) : briefAttention(scenario === 'many'),
   updates: empty ? [] : [{ id: 'upd_priya', kind: 'approval', title: 'Proposal approved', line: 'Scope and ₹2.4 lakh budget confirmed.', person: 'Priya Nair', on: '2026-11-22',
     action: { kind: 'thank', source_id: overviewId('priya'), draft: 'Thank you, Priya.' },
     evidence: [briefEvidence('ours', 'sent', 'Attached is our proposal for the project scope', '2026-11-22'), briefEvidence('priya', 'received', 'Approved. Scope and ₹2.4 lakh budget confirmed', '2026-11-22')] }],
  });
 }
 if (scenario === 'empty') return overviewJson({ account, items: [] });
 return overviewJson({ account, items: [{ id: 'done_pricing', title: 'Pricing sheet sent to Priya', line: 'Attached: pricing-sheet.pdf', sent_at: '2026-11-22T04:08:00+00:00', to: 'Priya Nair', source_id: overviewId('sent') }] });
};
const overviewApi = async (path: string, options: { body?: string } = {}) => {
 if (path.endsWith('/brief') || path.endsWith('/completed')) return briefApi(path);
 const scenario = document.documentElement.dataset.overview || 'populated';
 const body = options.body ? JSON.parse(options.body) : {};
 if (scenario === 'slow') return new Promise<Response>(() => {});
 if (scenario === 'failed') return overviewJson({ detail: { code: 'RETRYABLE', message: 'Mail is temporarily unavailable.' } }, 503);
 if (scenario === 'reconnect') return overviewJson({ detail: { code: 'RECONNECT_REQUIRED', message: 'Reconnect your mail to continue.' } }, 409);
 if (path.endsWith('/recent')) {
  if (scenario === 'empty') return overviewJson(overviewPage('recent', [], false));
  const all = overviewRows.map(overviewRow);
  const limit = Math.min(Number(body.limit) || 5, all.length);
  return overviewJson(overviewPage('recent', all.slice(0, limit), limit < all.length || scenario === 'capped'));
 }
 if (path.endsWith('/search')) {
  if (String(body.query).includes('nomatch')) return overviewJson(overviewPage('search', [], false));
  return overviewJson(overviewPage('search', overviewRows.filter(row => ['inv1', 'inv2', 'bank'].includes(row.name)).map(overviewRow), scenario === 'capped'));
 }
 if (path.endsWith('/open')) {
  const briefName = Object.keys(briefMail).find(name => overviewId(name) === body.source_id);
  if (briefName && scenario !== 'gone') {
   const mail = briefMail[briefName]!;
   return overviewJson({ account: 'synthetic-account', message: { source_id: body.source_id, subject: mail.subject, sender: mail.sender, received_at: minutesAgo(mail.at), unread: false, body: mail.body, body_truncated: false } });
  }
  const row = overviewRows.find(candidate => overviewId(candidate.name) === body.source_id);
  if (!row || scenario === 'gone') return overviewJson({ detail: { code: 'SOURCE_CHANGED', message: "That email can't be found now." } }, 410);
  return overviewJson({ account: 'synthetic-account', message: {
   source_id: body.source_id, subject: row.subject, sender: row.sender, received_at: minutesAgo(row.at), unread: row.unread,
   body: `Hi,\n\n${row.preview ?? ''}\n\nA line with <b>markup</b> and https://example.com/link that must stay plain text.\n\nThanks,\n${row.sender}`, body_truncated: row.name === 'long',
  } });
 }
 if (path.endsWith('/reply-source')) {
  return overviewJson({ account: 'synthetic-account', reply: { source_mail_ref: `rs1.${'x'.repeat(40)}`, to: 'sender@example.com', recipient_label: 'Sender', subject: 'Re: Q4 planning notes', expires_in_seconds: 900 } });
 }
 return overviewJson({ detail: { code: 'UNKNOWN' } }, 404);
};
const apiServiceStub: Record<string, unknown> = {
 getAuthHeaders: (token?: string) => token ? { Authorization: `Bearer ${token}` } : {},
 // Only One's mailbox check and the email behind a finding may reach the page's own fetch, where a test answers them.
 apiFetch: (path: string, options?: { body?: string }) => path.startsWith('/api/one/mail/overview/')
  ? overviewApi(path, options)
  : /^\/api\/kai\/gmail\/receipts\/notice(\/source)?$/.test(path)
    ? window.fetch(path, options as RequestInit)
    : Promise.reject(new Error('Unhandled fixture network request')),
 getPersonalAgentStatus: async () => ({ hostingMode: 'shared' }),
};
export const ApiService = new Proxy(apiServiceStub, { get: (target, name) => name in target ? target[name as string]
 : async () => { throw new Error('Unhandled fixture network request'); } });
export const HushhPersonalKnowledgeModel = {};
export const HushhVault = {};
export const useNativeOverlayCollisionPadding = () => 16;
export const useVoiceSurfaceMetadata = () => null;
export const getVoiceSurfaceMetadata = () => null;
export const HushhConsent = {};
export const HushhNotifications = {};
export const HushhLocation = {};
export const isMarketInsightsEmptyError = () => false;
export class MarketNewsSnapshotChangedError extends Error {}
export const HushhKeychain = {};
export const auth = { currentUser: user };
export const app = {};
export const RecaptchaVerifier = class {};

export const useConsentPendingSummaryCount = () => null;
export const useFeedUnreadCount = () => null;
