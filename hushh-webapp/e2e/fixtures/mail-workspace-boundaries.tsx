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
 { accountId: 'a'.repeat(32), credentialId: '11111111-2222-4333-8444-555555555555', email: 'work@workspace.example', provider: 'google', status: 'connected', isDefault: true, accessLevel: 'manage', capabilities: { read: true, manage: true } },
 { accountId: 'b'.repeat(32), credentialId: '22222222-2222-4333-8444-555555555555', email: 'personal@gmail.example', provider: 'google', status: 'connected', isDefault: false, accessLevel: 'manage', capabilities: { read: true, manage: true } },
];
export const ownerContentIsPrivate = async () => document.documentElement.dataset.mailAccounts === '1';
export const privateAgentSpecialistTurn = async () => { throw new Error('Unavailable in mailbox layout fixture'); };
export const ApiService = new Proxy({}, { get: (_target, method) => async (route: string, init?: RequestInit) => {
 if (method === 'ownerPodRequest' && document.documentElement.dataset.mailAccounts === '1') {
  if (route === 'connectors/gmail/accounts' && init?.method === 'GET') return new Response(JSON.stringify({ accounts: mailboxFixtures }));
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
