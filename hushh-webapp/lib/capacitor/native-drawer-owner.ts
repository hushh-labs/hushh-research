import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "../auth/session-owner";
import { snapshotVaultSessionEpoch } from "../vault/session-epoch";
import { nativeDocumentId } from "./session-privacy";
import type { NativeDrawerFamily, NativeDrawerIdentity } from "./native-drawers";

type Owner = Pick<NativeDrawerIdentity, "documentId" | "ownerEpoch" | "ownerGeneration">;
let current: { owner: Owner; authGeneration: number; vaultEpoch: number } | null = null;
let generation = 0;
let revision = 0;

/** Nonsecret document-local identities survive React remounts. Native receives
 * neither the account identifier nor a vault credential. History and Profile
 * share the same owner boundary; the feature still checks its live readiness. */
export function captureNativeDrawerOwner(): Owner | null {
  if (typeof window === "undefined") return null;
  const auth = snapshotValidatedAuthSessionOwner();
  if (!auth) { current = null; return null; }
  const vaultEpoch = snapshotVaultSessionEpoch();
  if (!current || current.authGeneration !== auth.generation || current.vaultEpoch !== vaultEpoch) {
    current = { authGeneration: auth.generation, vaultEpoch,
      owner: { documentId: nativeDocumentId(), ownerEpoch: crypto.randomUUID(), ownerGeneration: ++generation } };
  }
  return current.owner;
}

export function nativeDrawerOwnerIsCurrent(owner: Owner): boolean {
  const auth = snapshotValidatedAuthSessionOwner();
  return !!auth && isValidatedAuthSessionOwnerCurrent(auth) && !!current &&
    current.authGeneration === auth.generation && current.vaultEpoch === snapshotVaultSessionEpoch() &&
    current.owner.documentId === owner.documentId && current.owner.ownerEpoch === owner.ownerEpoch &&
    current.owner.ownerGeneration === owner.ownerGeneration;
}

export function createNativePresentationIdentity(): (Owner & { revision: number }) | null {
  const owner = captureNativeDrawerOwner();
  return owner ? { ...owner, revision: ++revision } : null;
}

export function createNativeDrawerIdentity(family: NativeDrawerFamily): NativeDrawerIdentity | null {
  const identity = createNativePresentationIdentity();
  return identity ? { ...identity, family } : null;
}
