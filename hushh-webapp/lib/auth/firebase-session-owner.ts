import { Capacitor } from "@capacitor/core";

import { AuthService } from "@/lib/services/auth-service";
import {
  isValidatedAuthSessionOwnerCurrent,
  type AccountPrincipalBinding,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";

export function isFirebaseSessionOwnerCurrent(
  principal: AccountPrincipalBinding & AuthSessionOwnerSnapshot,
): boolean {
  if (!isValidatedAuthSessionOwnerCurrent(principal)) return false;
  const firebaseUser = AuthService.getCurrentUser();
  // AuthProvider can validate a native session without mirroring it to Firebase JS.
  return firebaseUser ? firebaseUser.uid === principal.firebaseUid : Capacitor.isNativePlatform();
}
