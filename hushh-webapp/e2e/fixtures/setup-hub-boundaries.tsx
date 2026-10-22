// Synthetic owner and inert network boundaries; renders the production hub.
import React from "react";
const noop = () => {};
const unavailable = async () => { throw new Error("Network disabled in layout fixture"); };
const router = { replace: noop, push: noop, prefetch: noop };
const params = new URLSearchParams();
let saved = false;
const listeners = new Set<(event: {type:string;key:string}) => void>();
window.addEventListener("fixture:ai-choice-saved", () => {
  saved = true;
  listeners.forEach(listener => listener({type:"set",key:"bootstrap:fixture"}));
});
export const useRouter = () => router;
export const useSearchParams = () => params;
export const useAuth = () => ({user:{uid:"fixture"},signOut:noop});
export const useVault = () => ({isVaultUnlocked:false});
export const useInitialContacts = () => ({ownerId:null,status:"idle",source:null,result:null});
export const InitialContactsOnboardingService = {getSnapshot: () => ({ownerId:null}),startSource:noop};
export const VaultUnlockDialog = () => null;
export const NativeTestBeacon = () => null;
export const usePublishVoiceSurfaceMetadata = noop;
export const useLocalOnboardingActionHandler = noop;
export const useOneConversationSession = () => noop;
export const notifyGeminiRuntimeConfigurationChanged = noop;
export const acknowledgeOneSetupExit = unavailable;
export const PreVaultSensitiveDraftService = {};
export const FinanceSetupDraftService = {};
export const PostUnlockSyncService = {};
export const PreVaultUserStateService = { getCachedBootstrapState: () => ({saved}), hasOneCloudProject: () => true, hasOneRuntimeChoice: (value: {saved:boolean}) => value.saved, bootstrapState: unavailable };
export const CACHE_KEYS = { PRE_VAULT_BOOTSTRAP: (id:string) => `bootstrap:${id}` };
export const CacheService = {getInstance: () => ({subscribe: (listener: (event:{type:string;key:string}) => void) => {listeners.add(listener);return () => listeners.delete(listener);}})};
/* eslint-disable @next/next/no-img-element -- Browser fixture preserves image geometry. */
export default function Image({alt="",unoptimized:_unoptimized,...props}:React.ImgHTMLAttributes<HTMLImageElement> & {unoptimized?:boolean}) {return <img alt={alt} {...props} />;}

export const resolveKaiOnboardingCompletion = () => false;

export const AccountIdentityService = { peekCachedIdentity: () => ({data:{phoneVerified:true}}), refreshCurrentUserIdentity: async () => ({phoneVerified:true}), hasVerifiedPhone: () => true };
export const useCapabilitySetupStates = () => ({byId:{},isLoading:false,isEnriching:false});
export const ApiService = {getByocSetupStatus: async () => ({status:"idle"})};
export const OneAgentPresence = () => null;
export const PublicProfileDiscoveryCard = () => null;

export const BufferHandoffScreen = () => null;
export const GuidedConnectionScreen = () => null;
export const VaultExplainerScreens = () => null;
export const migrateOnboardingBuffer = unavailable;
export const isPersonalAgentReadyFromCachedFeed = () => false;

// Production readiness stays active; credential and Contacts I/O remain inert.
export const GEMINI_RUNTIME_CREDENTIAL_REF = "pkm:runtime_secrets.llm.gemini_api_key";
export const PersonalKnowledgeModelService = { loadRuntimeSecret: unavailable };
export const hasSavedAzureKey = unavailable;
export const hasSavedOpenAiKey = unavailable;
export const loadSelectedAiProvider = unavailable;
