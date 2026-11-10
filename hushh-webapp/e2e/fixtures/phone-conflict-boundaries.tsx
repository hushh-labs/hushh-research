/** Recorded external Firebase SDK and Next router transports, fixture-only.
 * No application service, auth policy, proof validator or durable writer is
 * replaced. Every account/phone operation goes through the real HTTP API.
 */
import React, { useSyncExternalStore } from "react";

type FixtureUser = {
  uid: string; email: string; displayName: string; emailVerified: boolean;
  phoneNumber: string | null; photoURL: null;
  providerData: { providerId: string }[];
  getIdToken: (force?: boolean) => Promise<string>;
  getIdTokenResult: () => Promise<{ signInProvider: string }>;
  reload: () => Promise<void>;
};
type Auth = { name: string; currentUser: FixtureUser | null; settings: Record<string, unknown> };
const listeners = new Set<(user: FixtureUser | null) => void>();
const apps: { name: string; options: Record<string, unknown> }[] = [];
const stores = new Map<string, Auth>();
let selected = "previous";

async function sdk(path: string, body?: unknown) {
  // eslint-disable-next-line no-restricted-syntax -- Recorded external Firebase SDK transport; application API services remain real.
  const response = await fetch(`/__phone_fixture/sdk/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error("Recorded provider refused"), { code: value.code });
  return value;
}
function user(value: { uid: string; provider: string; phone: string | null }): FixtureUser {
  return { uid: value.uid, email: `${value.uid}@example.test`, displayName: "Synthetic account",
    emailVerified: true, phoneNumber: value.phone, photoURL: null,
    providerData: [{ providerId: value.provider }],
    getIdToken: async () => (await sdk("token", { uid: value.uid })).token,
    getIdTokenResult: async () => ({ signInProvider: value.provider }),
    reload: async () => undefined };
}
export function initializeApp(options: Record<string, unknown>, name = "[DEFAULT]") {
  const app = { name, options }; apps.push(app); return app;
}
export const getApps = () => apps;
export const getApp = () => apps[0];
export function getAuth(app = getApp()) {
  const name = app?.name ?? "[DEFAULT]";
  if (!stores.has(name)) stores.set(name, { name, currentUser: null, settings: {} });
  return stores.get(name)!;
}
const initial = await sdk("state");
getAuth().currentUser = initial.user ? user(initial.user) : null;
export function onAuthStateChanged(auth: Auth, listener: (value: FixtureUser | null) => void) {
  listeners.add(listener); queueMicrotask(() => listener(auth.currentUser));
  return () => listeners.delete(listener);
}
function publish(auth: Auth, value: FixtureUser | null) {
  auth.currentUser = value;
  if (auth.name === "[DEFAULT]") for (const listener of listeners) listener(value);
}
export async function selectFixtureAccount(owner: "previous" | "wrong" | "receiving-a") {
  selected = owner;
  return signInWithPopup(getAuth(), initial.provider === "apple.com" ? new OAuthProvider("apple.com") : new GoogleAuthProvider());
}
export class GoogleAuthProvider {
  providerId = "google.com";
  setCustomParameters() {} addScope() {}
  static credential() { return { providerId: "google.com" }; }
  static credentialFromResult() { return { accessToken: "synthetic-oauth" }; }
}
export class OAuthProvider extends GoogleAuthProvider {
  constructor(provider: string) { super(); this.providerId = provider; }
  credential() { return { providerId: this.providerId }; }
}
export async function signInWithPopup(auth: Auth, provider: GoogleAuthProvider) {
  const result = await sdk("sign-in", { owner: selected, provider: provider.providerId });
  const value = user(result.user); publish(auth, value); return { user: value };
}
export async function reauthenticateWithPopup(current: FixtureUser, provider: GoogleAuthProvider) {
  const result = await sdk("reauthenticate", { uid: current.uid, provider: provider.providerId });
  if (getAuth().currentUser !== current) throw Object.assign(new Error("Account changed"), { code: "auth/user-mismatch" });
  return { user: current, ...result };
}
export async function signOut(auth: Auth) {
  if (auth.name === "[DEFAULT]") await sdk("sign-out", {});
  publish(auth, null);
}
export class RecaptchaVerifier {
  constructor(_auth: unknown, _container: unknown, _options: unknown) {}
  render() { return Promise.resolve(1); } clear() {}
}
export class PhoneAuthProvider {
  constructor(_auth: Auth) {}
  async verifyPhoneNumber(phone: string, _verifier?: unknown) { return (await sdk("send", { phone })).verificationId; }
  static credential(verificationId: string, verificationCode: string) { return { verificationId, verificationCode }; }
}
export async function signInWithCredential(auth: Auth, credential: { verificationId: string; verificationCode: string }) {
  const result = await sdk("verify", credential);
  const value = { ...user(result.user), getIdToken: async () => result.token };
  publish(auth, value); return { user: value };
}
export const inMemoryPersistence = {};
export const setPersistence = async () => undefined;
export const getAdditionalUserInfo = () => ({ isNewUser: false });
const unavailable = async () => { throw new Error("Unreviewed Firebase operation in phone fixture"); };
// This recorded fixture has no configured direct Google grant; fail closed if used.
export const reauthenticateWithCredential = unavailable;
export const linkWithCredential = unavailable;
export const linkWithPopup = unavailable;
export const updatePhoneNumber = unavailable;
export const signInWithCustomToken = unavailable;
export const isSupported = async () => false;
export const getAnalytics = unavailable;
export const getMessaging = unavailable;
export const setUserId = () => undefined;
export const setUserProperties = () => undefined;
export const logEvent = () => undefined;
export const setAnalyticsCollectionEnabled = () => undefined;
export const deleteToken = async () => true;
export const getToken = unavailable;
export const onMessage = () => () => undefined;

const routeListeners = new Set<() => void>();
const locationSnapshot = () => `${window.location.pathname}${window.location.search}`;
const subscribe = (listener: () => void) => { routeListeners.add(listener); return () => routeListeners.delete(listener); };
function navigate(href: string, replace: boolean) {
  if (replace) window.history.replaceState({}, "", href); else window.history.pushState({}, "", href);
  for (const listener of routeListeners) listener();
}
const router = { push: (href: string) => navigate(href, false), replace: (href: string) => navigate(href, true),
  back: () => window.history.back(), prefetch: () => undefined, refresh: () => navigate(locationSnapshot(), true) };
window.addEventListener("popstate", () => { for (const listener of routeListeners) listener(); });
export function useRouter() { return router; }
export function usePathname() { return useSyncExternalStore(subscribe, locationSnapshot).split("?")[0]; }
export function useSearchParams() { return new URLSearchParams(useSyncExternalStore(subscribe, locationSnapshot).split("?")[1]); }
export function useParams() { return {}; }
export function redirect(href: string) { router.replace(href); }
export default function NextElement({ href, src, children, alt = "", priority: _priority, unoptimized: _unoptimized, ...props }: Record<string, any>) {
  // eslint-disable-next-line @next/next/no-img-element -- Isolated Vite fixture preserves the Next Image transport using a native image.
  return href ? <a href={href} {...props}>{children}</a> : <img src={src} alt={alt} {...props} />;
}
