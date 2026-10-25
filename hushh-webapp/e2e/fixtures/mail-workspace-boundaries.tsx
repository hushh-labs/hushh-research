import { createContext } from 'react';
export const usePathname = () => document.documentElement.dataset.workspace === 'setup' ? '/one/setup/gmail' : document.documentElement.dataset.workspace?.startsWith('callback') ? '/one/profile/gmail/oauth/return' : '/one/gmail';
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
const syntheticEmail = document.documentElement.dataset.stress === 'long' ? 'alexander.morgan.with.a.very.long.name@international-research-and-services.example' : 'alex.morgan@northstar.example';
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
export const ApiService = new Proxy({}, { get: (_target, name) => name === 'getPersonalAgentStatus'
 ? async () => ({ hostingMode: 'shared' })
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
