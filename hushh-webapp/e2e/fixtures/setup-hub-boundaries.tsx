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
export const useAuth = () => ({user:{uid:"fixture"}});
export const useVault = () => ({isVaultUnlocked:false});
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
export const PreVaultUserStateService = { getCachedBootstrapState: () => ({saved}), hasOneRuntimeChoice: (value: {saved:boolean}) => value.saved, bootstrapState: unavailable };
export const CACHE_KEYS = { PRE_VAULT_BOOTSTRAP: (id:string) => `bootstrap:${id}` };
export const CacheService = {getInstance: () => ({subscribe: (listener: (event:{type:string;key:string}) => void) => {listeners.add(listener);return () => listeners.delete(listener);}})};
/* eslint-disable @next/next/no-img-element -- Browser fixture preserves image geometry. */
export default function Image({alt="",unoptimized:_unoptimized,...props}:React.ImgHTMLAttributes<HTMLImageElement> & {unoptimized?:boolean}) {return <img alt={alt} {...props} />;}

export const resolveKaiOnboardingCompletion = () => false;
