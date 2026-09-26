// Presentation-only fixture: real page, fields and dialogs; inert identity and
// network boundaries. Never installed in the application or used for real SMS.
import React, { type ReactNode } from "react";
const noop = () => {};
const unavailable = async () => { throw new Error("Network disabled in layout fixture"); };
const user = { uid: "layout-fixture", phoneNumber: null, getIdToken: unavailable };
const router = { replace: noop, back: noop, push: noop };
const params = new URLSearchParams();
export const useRouter = () => router;
export const usePathname = () => "/register-phone";
export const useSearchParams = () => params;
export const useAuth = () => ({ user, loading: false, phoneNumber: null, startPhoneVerification: unavailable, confirmPhoneVerification: unavailable, refreshUser: unavailable, signOut: unavailable });
export const NativeRouteMarker = () => null;
export const VaultLockGuard = ({ children }: { children: ReactNode }) => children;
export const AccountIdentityService = { syncCurrentUser: unavailable, hasVerifiedPhone: () => false };
export const PostAuthRouteService = { resolveAfterLogin: unavailable };
export const PreVaultUserStateService = { bootstrapState: unavailable, isSetupResolved: () => false, syncOnboardingJourney: unavailable };
export const RiaService = { claimLookup: unavailable };
export const setOnboardingFlowActiveCookie = noop;
export const setOnboardingRequiredCookie = noop;
export const usePublishVoiceSurfaceMetadata = noop;
export const useLocalOnboardingActionHandler = noop;
export const trackEvent = noop;
export const ApiService = { apiFetch: unavailable };
/* eslint-disable @next/next/no-img-element -- Native img is intentional in the isolated Vite fixture. */
export default function Image({ alt = "", unoptimized: _unoptimized, priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean; priority?: boolean }) { return <img alt={alt} {...props} />; }
