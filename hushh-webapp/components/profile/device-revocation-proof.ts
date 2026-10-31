import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";
import { AuthService } from "@/lib/services/auth-service";
import { prepareRecaptchaVerifier, resetRecaptcha } from "@/lib/firebase/config";
import { PhoneRecoveryService, type DeviceRevocationPreparation, type DeviceRevocationProof, type DeviceRevocationStatus } from "@/lib/services/phone-recovery-service";

export type DeviceProofView = { preparing: boolean; sending: boolean; codeSent: boolean; resendReady: boolean; phoneHint: string; error: string; transport: "sms" | "configured_test" | null };
const EMPTY: DeviceProofView = { preparing: false, sending: false, codeSent: false, resendReady: true, phoneHint: "", error: "", transport: null };

/** One memory-only proof per chosen device. Its caller remains the owner authority. */
export class DeviceRevocationProofSession {
  private active = true;
  private pending = false;
  private preparation: DeviceRevocationPreparation | null = null;
  private attempt: string | null = null;
  private verificationId = "";
  private token = "";
  private resendAt = 0;
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private cancellation: Promise<DeviceRevocationStatus | null> | null = null;
  view = { ...EMPTY };
  constructor(private user: User, private device: string, private current: () => boolean,
    private resolvePhone: () => Promise<string | null>, private publish: (view: DeviceProofView) => void,
    private continuationId?: string) {}
  private valid = () => this.active && this.current();
  private update(next: Partial<DeviceProofView>) {
    if (this.valid()) { this.view = { ...this.view, ...next }; this.publish(this.view); }
  }
  ownsOperation(id: string) { return this.preparation?.operation_id === id; }
  async prepare() {
    if (!this.valid() || this.pending) return;
    this.pending = true; this.update({ preparing: true, error: "" });
    try {
      const value = await PhoneRecoveryService.prepareRevocation(this.user, this.device, this.valid, this.continuationId);
      if (!this.valid()) return;
      if (!value.operation_id || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now() ||
        !["sms", "configured_test"].includes(value.transport)) throw new Error();
      this.preparation = value;
      this.update({ phoneHint: value.phone_hint, transport: value.transport, codeSent: value.transport === "configured_test" });
    } catch { this.update({ error: "Couldn’t prepare verification. Close this and try again." }); }
    finally { this.pending = false; this.update({ preparing: false }); }
  }
  async send() {
    if (!this.valid() || this.pending || !this.preparation || this.preparation.transport !== "sms" || Date.now() < this.resendAt) return;
    this.pending = true; this.update({ sending: true, error: "" });
    const resendCode = !!this.attempt;
    if (this.attempt) void AuthService.cancelPhoneDeletionVerification(this.attempt).catch(() => undefined);
    const attempt = crypto.randomUUID(); this.attempt = attempt; this.verificationId = ""; this.token = "";
    try {
      if (Date.parse(this.preparation.expires_at) <= Date.now()) throw new Error();
      await waitForFreshProof(this.preparation.proof_wait_ms, this.controller.signal);
      if (!this.valid()) return;
      const phone = await this.resolvePhone();
      if (!this.valid() || this.attempt !== attempt) return;
      if (!phone) throw new Error();
      const verifier = Capacitor.isNativePlatform() ? undefined : await prepareRecaptchaVerifier("trusted-device-revoke-recaptcha");
      const result = await AuthService.startPhoneDeletionVerification(phone, verifier,
        { expectedUserId: this.user.uid, attemptId: attempt, resendCode, signal: this.controller.signal });
      if (!this.valid() || this.attempt !== attempt) return;
      this.verificationId = "verificationId" in result ? result.verificationId : "";
      this.token = "phoneIdToken" in result ? result.phoneIdToken : "";
      this.resendAt = Date.now() + 30_000;
      this.update({ codeSent: true, resendReady: false });
      this.resendTimer = setTimeout(() => this.update({ resendReady: true }), 30_000);
    } catch { this.update({ error: "Couldn’t send the code. Try again." }); }
    finally { this.pending = false; this.update({ sending: false }); }
  }
  async proof(code: string): Promise<DeviceRevocationProof | null> {
    const operation = this.preparation;
    if (!this.valid() || this.pending || !operation || Date.parse(operation.expires_at) <= Date.now()) {
      this.update({ error: "Verification ended. Close this and try again." }); return null;
    }
    if (operation.transport === "configured_test") {
      if (!/^\d{6}$/.test(code)) { this.update({ error: "Enter the six-digit code." }); return null; }
      return { operation_id: operation.operation_id, confirmed: true, test_code: code };
    }
    if (!this.token && (!this.attempt || !this.verificationId || !/^\d{6}$/.test(code))) {
      this.update({ error: "Request a code, then enter all six digits." }); return null;
    }
    this.pending = true;
    try {
      const token = this.token || await AuthService.confirmPhoneDeletionVerification({ verificationCode: code,
        verificationId: this.verificationId, expectedUserId: this.user.uid, attemptId: this.attempt! });
      if (!this.valid()) return null;
      return { operation_id: operation.operation_id, confirmed: true, phone_id_token: token };
    } catch { this.update({ error: "That code did not work. Check it or request another." }); return null; }
    finally { this.pending = false; }
  }
  cancel(): Promise<DeviceRevocationStatus | null> {
    if (this.cancellation) return this.cancellation;
    const operation = this.preparation?.operation_id;
    this.active = false; this.controller.abort();
    if (this.resendTimer) clearTimeout(this.resendTimer);
    if (this.attempt) void AuthService.cancelPhoneDeletionVerification(this.attempt).catch(() => undefined);
    this.preparation = null; this.verificationId = ""; this.token = ""; resetRecaptcha();
    this.cancellation = operation && this.current()
      ? PhoneRecoveryService.cancelRevocation(this.user, operation, this.current).catch(() => null) : Promise.resolve(null);
    return this.cancellation;
  }
  dispose() { void this.cancel(); }
}

/** Firebase auth_time is second-granular; respect only the server's <=1s floor. */
function waitForFreshProof(ms: number, signal: AbortSignal): Promise<void> {
  if (!Number.isInteger(ms) || ms < 0 || ms > 1000 || signal.aborted) return Promise.reject(new Error("Verification cancelled."));
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Verification cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, {once: true});
  });
}
