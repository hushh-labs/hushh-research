// Synthetic identity, vault controls and intercepted HTTP only. The requester
// card, response parser, recipient crypto, Markdown and Radix Avatar are real.
import { createContext, useContext, useState, type ReactNode } from "react";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

export const PHOTO_REQUESTER = "synthetic-photo-requester";
let token = PHOTO_REQUESTER;
type Session = { uid: string; unlocked: boolean; generation: number };
const SessionContext = createContext<{
  session: Session;
  change: (uid: string, unlocked: boolean) => void;
} | null>(null);

export function FixtureSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ uid: PHOTO_REQUESTER, unlocked: false, generation: 0 });
  return <SessionContext.Provider value={{ session, change(uid, unlocked) {
    advanceVaultSessionEpoch();
    token = uid;
    setSession(previous => ({ uid, unlocked, generation: previous.generation + 1 }));
  } }}>{children}</SessionContext.Provider>;
}

export function useFixtureSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Missing fixture session");
  return value;
}
export function useAuth() {
  const { session } = useFixtureSession();
  return { user: { uid: session.uid }, userId: session.uid, loading: false };
}
export function useVault() {
  const { session } = useFixtureSession();
  return {
    isVaultUnlocked: session.unlocked,
    vaultKey: session.unlocked ? "synthetic-unused-owner-key" : null,
    vaultOwnerToken: `${session.uid}:${session.generation}`,
  };
}
export const AuthService = { getIdToken: async () => token };
export const ApiService = {
  apiFetch: (path: string, options: RequestInit = {}) =>
    // eslint-disable-next-line no-restricted-syntax -- Synthetic HTTP is intercepted by Playwright; no external records.
    fetch(path, options),
};
export const CacheSyncService = { onConsentMutated: () => undefined };

// Owner preparation is unreachable in these requester-only fixtures.
export function AnswerRequestReview() { throw new Error("Unexpected owner review"); }
export async function runAnswerDeliverySweep() { throw new Error("Unexpected owner preparation"); }
export function VaultUnlockDialog({ open }: { open: boolean }) {
  const { session, change } = useFixtureSession();
  return open ? <div role="dialog" aria-label="Fixture unlock">
    <button onClick={() => change(session.uid, true)}>Unlock fixture vault</button>
  </div> : null;
}
