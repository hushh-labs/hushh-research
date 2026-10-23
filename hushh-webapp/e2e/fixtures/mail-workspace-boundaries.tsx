import { createContext } from 'react';
export const usePathname = () => '/one/gmail';
const params = new URLSearchParams();
export const useSearchParams = () => params;
const router = { push() {}, replace() {}, prefetch() {} };
export const useRouter = () => router;
const user = { uid: 'synthetic-owner', displayName: 'Alex Morgan', email: 'alex@example.com', getIdToken: async () => 'synthetic-id-token' };
export const useAuth = () => ({ user, loading: false, isAuthenticated: true });
export const useRequireAuth = useAuth;
const vault = { vaultKey: '12'.repeat(32), vaultOwnerToken: 'synthetic-owner-token', isVaultUnlocked: true };
export const VaultContext = createContext(vault);
export const useVault = () => vault;
export const useEffectiveAvatarUrl = () => null;
export const usePersonaState = () => ({ activePersona: 'investor', riaCapability: 'disabled', riaEntryRoute: '/ria', switchPersona() {} });
export const useNativePresentationRegions = () => {};
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
export const HushhAuth = {};
export const VaultUnlockDialog = () => null;
const gmail = {
 status: { connected: true, configured: true, google_sub: 'synthetic-account', google_email: 'alex.morgan@northstar.example', account_email: 'alex.morgan@northstar.example', email: 'alex.morgan@northstar.example', receipt_sync_available: true, connection_state: 'connected', last_sync_status: 'completed', last_sync_at: '2026-10-21T12:00:00Z' },
 loadingStatus: false, statusError: null, syncRun: null, sync: async () => {}, refreshStatus: async () => {},
 presentation: { isConnected: true, state: 'connected', badgeLabel: 'Connected' },
};
export const useGmailConnectorStatus = () => gmail;
export const PreVaultUserStateService = { getCachedBootstrapState: () => ({ onboarding_completed: true }), getCached: () => ({}), get: async () => ({}), refresh: async () => ({}), getBootstrapState: async () => ({}) };
export const KycIdentityProfilePkmService = { hasCompletedIntake: async () => document.documentElement.dataset.queue === '1' };
export const GmailInformationRequestsService = {
 getPreference: async () => ({ user_id: user.uid, monitoring_enabled: false, retention: 'metadata_only', disclosure: 'Only new inbox messages are checked.' }),
 list: async () => ({ workflows: [], next_offset: null, total_count: 0 }),
 scanStream: async () => { throw new Error('Unavailable in screenshot fixture'); },
};
const mailboxFixtures = [
 { accountId: 'a'.repeat(32), credentialId: '11111111-2222-4333-8444-555555555555', email: 'work@workspace.example', provider: 'google', status: 'connected', isDefault: true, accessLevel: 'manage', capabilities: { read: true, manage: true }, receiptSyncAvailable: true },
 { accountId: 'b'.repeat(32), credentialId: '22222222-2222-4333-8444-555555555555', email: 'personal@gmail.example', provider: 'google', status: 'connected', isDefault: false, accessLevel: 'manage', capabilities: { read: true, manage: true }, receiptSyncAvailable: true },
];
export const ownerContentIsPrivate = async () => document.documentElement.dataset.mailAccounts === '1';
export const privateAgentSpecialistTurn = async () => { throw new Error('Unavailable in mailbox layout fixture'); };
export const ApiService = new Proxy({}, { get: (_target, method) => async (route: string, init?: RequestInit) => {
 if (method === 'ownerPodRequest' && document.documentElement.dataset.mailAccounts === '1') {
  if (route === 'connectors/gmail/accounts' && init?.method === 'GET') return new Response(JSON.stringify({ accounts: mailboxFixtures }));
  if (/^connectors\/gmail\/accounts\/[a-f0-9]{32}\/receipts\/scan$/.test(route) && init?.method === 'POST') {
   const index = mailboxFixtures.findIndex(account => route.includes(account.accountId));
   const body = JSON.parse(String(init.body));
   if (index < 0 || body.credential_id !== mailboxFixtures[index]!.credentialId) return new Response(null, { status: 409 });
   const id = index + 1;
   const item = { id, source_id: `synthetic-receipt-${id}`, receipt_key: `synthetic-receipt-${id}`, source_kind: 'gmail_live',
    event_id: String(id).repeat(64), gmail_message_id: `synthetic-message-${id}`, gmail_thread_id: null,
    merchant_name: 'Amazon', merchant_domain: 'amazon.com', sender_domain: 'amazon.com', from_name: null, from_email: null,
    order_id: null, currency: 'USD', receipt_date: '2026-10-10', transaction_date: '2026-10-10', gmail_internal_date: '2026-10-10T12:00:00Z',
    subject: null, preview: null, snippet: null, amount: id / 10, amount_decimal: `0.${id}0`, classification_source: 'agent', classification_confidence: 1,
    event_type: 'purchase', status: 'paid', document_kind: 'receipt', recurrence: 'recurring', category: 'Shopping', category_confidence: 1,
    identifiers: [{ kind: 'invoice', value: `INVOICE-${id}` }] };
   return Response.json({ items: [item], page: 1, per_page: 6, returned_count: 1, has_more: false, coverage: {
    source: 'gmail_live', listed_count: 1, candidate_count: 1, matched_count: 1, pages_scanned: 1, max_messages: 6, max_pages: 50,
    reached_limit: false, window_start: '2025-10-23T00:00:00Z', window_end: '2026-10-23T00:00:00Z', query_scope: 'receipt_signals_all_mail_except_spam_trash',
    rejection_counts: { missing_receipt_signal: 0, extractor_not_receipt: 0 },
    evidence_counts: { gmail_category: 0, subject_signal: 1, body_signal: 0, verified_merchant: 1, order_candidate: 1, total_candidate: 1 },
   } });
  }
  if (route.startsWith('connectors/gmail/accounts/') && init?.method === 'DELETE') {
   const accountId = route.split('/').pop()!.split('?')[0];
   const index = mailboxFixtures.findIndex(account => account.accountId === accountId);
   if (index >= 0) mailboxFixtures.splice(index, 1);
   return new Response(JSON.stringify({ accountId, status: 'absent', providerRevoked: true }));
  }
 }
 throw new Error('Unhandled fixture network request');
} });
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
