import type { User } from "firebase/auth";
import type { AccountIdentity } from "@/lib/services/api-service";

type PhoneAttempt = { userId: string; epoch: number };
type RecoveryPorts = {
  isNative: () => boolean;
  currentUser: () => User | null;
  currentPhone: () => string | null;
  currentOwner: () => string | undefined;
  refreshIdentity: (user: User) => Promise<AccountIdentity | null>;
  readProviderUser: (uid: string) => Promise<User | null>;
  requireOwner: (uid: string | null | undefined, epoch: number) => void;
  persistPhone: (user: User, phone: string) => Promise<void>;
  attemptIsCurrent: (uid: string, epoch: number) => boolean;
  retireAttempt: () => void;
};

/** Recovery owns temporary request resources; AuthProvider retains all identity authority. */
export function createPhoneVerificationRecovery(ports: RecoveryPorts) {
  let nativeStart: AbortController | null = null;
  const confirmingUsers = new Set<string>();

  function requireIdle(userId: string): void {
    if (confirmingUsers.has(userId)) {
      throw Object.assign(new Error("Phone verification is finishing. Wait a moment and try again."), {
        code: "phone_verification_busy",
      });
    }
  }

  function cancelNativeStart(): void {
    nativeStart?.abort();
    nativeStart = null;
  }

  function beginNativeStart(isNative: boolean): AbortSignal | undefined {
    cancelNativeStart();
    nativeStart = isNative ? new AbortController() : null;
    return nativeStart?.signal;
  }

  function retireExpiredPhoneVerification(error: unknown, attempt: PhoneAttempt | null): void {
    const code = String((error as { code?: unknown })?.code ?? "").replace(/^auth\//, "");
    if (code === "code-expired" && attempt && ports.attemptIsCurrent(attempt.userId, attempt.epoch)) {
      ports.retireAttempt();
    }
  }

  async function confirmAttempt<T>(attempt: PhoneAttempt | null, work: () => Promise<T>): Promise<T> {
    if (!attempt) {
      throw Object.assign(new Error("Request a new verification code before verifying again."), { code: "phone-verification-required" });
    }
    requireIdle(attempt.userId);
    // Keep the slot through provider dispatch and app persistence, even if the
    // current view or account changes while an exchange is already on the wire.
    confirmingUsers.add(attempt.userId);
    try {
      return await work();
    } catch (error) {
      // Explicit expiry retires only the exact owner/epoch supplied by AuthProvider.
      retireExpiredPhoneVerification(error, attempt);
      throw error;
    } finally {
      confirmingUsers.delete(attempt.userId);
    }
  }

  async function confirmRetainedNativePhone(phone: string, uid: string, epoch: number): Promise<User | null> {
    const user = ports.currentUser();
    const owner = ports.currentOwner();
    if (!ports.isNative() || !user || ports.currentPhone() !== phone) return null;
    // A cached app claim needs fresh owner-bound persistence evidence before reuse.
    const identity = await ports.refreshIdentity(user);
    ports.requireOwner(uid, epoch);
    if (!identity || identity.user_id !== owner) {
      throw new Error("Saved phone verification could not be confirmed. Please retry.");
    }
    return identity.phone_verified === true && identity.phone_number === phone ? user : null;
  }

  async function finalizeLinkedProviderPhone(
    phone: string, uid: string, epoch: number,
  ): Promise<User | null> {
    if (!phone) return null;
    // Reading the provider must not publish a claim whose backend write failed.
    const user = await ports.readProviderUser(uid);
    ports.requireOwner(uid, epoch);
    if (!user || user.uid !== uid) {
      throw new Error("The verified account changed. Start phone verification again.");
    }
    if (user.phoneNumber !== phone) return null;
    await ports.persistPhone(user, phone);
    ports.requireOwner(uid, epoch);
    return user;
  }

  return { cancelNativeStart, beginNativeStart, requireIdle, confirmAttempt, confirmRetainedNativePhone, finalizeLinkedProviderPhone };
}
