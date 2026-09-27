// Synthetic owner and inert network boundaries; renders the production AI selection page.
import React from "react";
const noop = () => {};
const unavailable = async () => { throw new Error("Network disabled in layout fixture"); };
const router = { replace: noop, push: noop, prefetch: noop };
const params = new URLSearchParams();
const listeners = new Set<(event: {type:string;key:string}) => void>();
window.addEventListener("fixture:ai-choice-saved", () => {
  listeners.forEach(listener => listener({type:"set",key:"bootstrap:fixture"}));
});
export const useRouter = () => router;
export const useSearchParams = () => params;
export const useAuth = () => ({user:{uid:"fixture"}});
export const useVault = () => ({isVaultUnlocked:false});
export const VaultUnlockDialog = ({open}: {open:boolean}) => open ? <div>Set a lock</div> : null;
export const NativeTestBeacon = () => null;
export const usePublishVoiceSurfaceMetadata = noop;
export const useLocalOnboardingActionHandler = noop;
export const useOneConversationSession = () => noop;
export const notifyGeminiRuntimeConfigurationChanged = noop;
export const acknowledgeOneSetupExit = unavailable;
let draft = false;
export const PreVaultSensitiveDraftService = {hasGeminiRuntime: () => draft, stageGeminiRuntime: () => {draft=true;}, clearGeminiRuntime: () => {draft=false;}};
export const FinanceSetupDraftService = {};
export const PostUnlockSyncService = {};
export const PreVaultUserStateService = {
  getCachedBootstrapState: () => ({oneRuntimeSetupChoice:null}), hasOneRuntimeChoice: () => false,
  bootstrapState: unavailable,
  markOneRuntimeChoice: async (_id:string, choice:string) => ({oneRuntimeSetupChoice:choice}),
};
export const CACHE_KEYS = { PRE_VAULT_BOOTSTRAP: (id:string) => `bootstrap:${id}` };
export const CacheService = {getInstance: () => ({subscribe: (listener: (event:{type:string;key:string}) => void) => {listeners.add(listener);return () => listeners.delete(listener);}})};
/* eslint-disable @next/next/no-img-element -- Browser fixture preserves image geometry. */
export default function Image({alt="",unoptimized:_unoptimized,...props}:React.ImgHTMLAttributes<HTMLImageElement> & {unoptimized?:boolean}) {return <img alt={alt} {...props} />;}

export const resolveKaiOnboardingCompletion = () => false;

export const ApiService = { validateGeminiRuntimeCredential: async ({credential}:{credential:string}) => {if(credential!=="fixture-valid") throw new Error("This key could not be validated.");return {status:"ready"};} };
export const VaultService = {checkVault: async () => false};
export const morphyToast = {success:noop,error:noop};
export const PersonalKnowledgeModelService = {loadRuntimeSecret: unavailable,storeRuntimeSecret: unavailable,removeRuntimeSecret: unavailable};
export const GEMINI_RUNTIME_CREDENTIAL_REF="fixture:credential";
export const GEMINI_RUNTIME_TRANSPORT_REF="fixture:transport";
export const GEMINI_VERTEX_LOCATION_REF="fixture:location";
export const GEMINI_VERTEX_PROJECT_REF="fixture:project";
export const RUNTIME_CREDENTIAL_MODE_REF="fixture:mode";
