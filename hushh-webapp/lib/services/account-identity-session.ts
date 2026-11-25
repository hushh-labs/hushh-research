import type { User } from "firebase/auth";
import { getAuthSessionGeneration, snapshotValidatedAuthSessionOwner, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

export function ownerForFirebaseUser(user: User | null | undefined): string | null {
  const principal = snapshotValidatedAuthSessionPrincipal();
  return user && principal?.firebaseUid === user.uid ? principal.ownerId : null;
}


export function identitySessionIsCurrent(userId: string, generation: number | null): boolean {
  const owner = snapshotValidatedAuthSessionOwner();
  return generation !== null && generation === getAuthSessionGeneration() &&
    (!owner || owner.userId === userId);
}
