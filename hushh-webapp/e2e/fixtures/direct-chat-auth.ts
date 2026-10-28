import { useSyncExternalStore } from "react";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
let uid = "fixture-owner";
let browserUserAvailable = true;
let tokenAvailable = true;
const listeners = new Set<() => void>();
const user = () => ({ uid, getIdToken: async () => "synthetic-token" });
let snapshot = { user: user(), userId: uid, loading: false, isAuthenticated: true };
publishValidatedAuthSessionOwner(uid);
export function changeOwner(next: string) { uid = next; publishValidatedAuthSessionOwner(uid); snapshot = { user: user(), userId: uid, loading: false, isAuthenticated: true }; for (const listener of listeners) listener(); }
export function useAuth() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot); }

export const auth = { get currentUser() { return browserUserAvailable ? snapshot.user : null; } };
export const app = { name: "direct-chat-fixture", options: {} };

// Synthetic auth port; production AuthService's native fallback and bounded
// retry are separately exercised by __tests__/services/auth-service.test.ts.
export const directChatAuthFixture = {
  tokenRequests: [] as string[],
  useNativeSession: () => { browserUserAvailable = false; },
  setTokenAvailable: (available: boolean) => { tokenAvailable = available; },
};
export class AuthService {
  static async getIdTokenWithRetry(options?: { expectedUserId?: string }) {
    directChatAuthFixture.tokenRequests.push(options?.expectedUserId ?? "");
    return tokenAvailable && options?.expectedUserId === uid ? "synthetic-token" : null;
  }
}
(window as unknown as { directChatAuthFixture: typeof directChatAuthFixture }).directChatAuthFixture = directChatAuthFixture;
