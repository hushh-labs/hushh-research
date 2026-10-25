import type { User } from "firebase/auth";

/** Bounds the entire native start, including preflight and session restoration. */
export const NATIVE_PHONE_VERIFICATION_START_TIMEOUT_MS = 120_000;
export const NATIVE_PHONE_VERIFICATION_CLEANUP_TIMEOUT_MS = 2_000;
type Handle = { remove: () => Promise<void> };
export type NativePhoneVerificationResult = {
  autoVerified: boolean;
  verificationId?: string;
  user?: User | null;
};
export type NativePhoneVerificationInput = {
  intent: "link" | "replace";
  phoneNumber: string;
  currentPhoneNumber: string;
  fenceSessions: boolean;
  resendCode?: boolean;
  timeout?: number;
  signal?: AbortSignal;
};
export interface NativePhoneVerificationPort {
  isSignedIn(): Promise<boolean>;
  onCodeSent(callback: (event: { verificationId: string }) => Promise<void>): Promise<Handle>;
  onFailure(callback: (event: { message?: string }) => Promise<void>): Promise<Handle>;
  onCompleted(callback: () => Promise<void>): Promise<Handle>;
  unlinkPhone(): Promise<unknown>;
  sendPhone(options: { phoneNumber: string; resendCode?: boolean; timeout?: number }): Promise<unknown>;
  restoreSession(): Promise<User | null>;
  normalizeError(error: unknown): Error;
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class NativePhoneStart {
  private settled = false;
  private eventClaimed = false;
  private requestStarted = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private handles: Handle[] = [];
  private resolve!: (result: NativePhoneVerificationResult) => void;
  private reject!: (error: Error) => void;

  constructor(private input: NativePhoneVerificationInput, private port: NativePhoneVerificationPort) {}

  run(): Promise<NativePhoneVerificationResult> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.deadline = setTimeout(() => {
        void this.rejectAttempt(failure("phone-verification-start-timeout",
          "Requesting a verification code took too long. Please try again."));
      }, NATIVE_PHONE_VERIFICATION_START_TIMEOUT_MS);
      this.input.signal?.addEventListener("abort", this.onAbort, { once: true });
      if (this.input.signal?.aborted) this.onAbort();
      else void this.prepare();
    });
  }

  private onAbort = () => {
    void this.rejectAttempt(failure("phone-verification-start-cancelled",
      "Phone verification was cancelled. Please start again."));
  };

  private async removeHandles(handles: Handle[]): Promise<void> {
    if (handles.length === 0) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(handles.map(handle => Promise.resolve().then(() => handle.remove()).catch(() => undefined))),
        new Promise<void>(done => {
          deadline = setTimeout(done, NATIVE_PHONE_VERIFICATION_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async cleanup(): Promise<void> {
    clearTimeout(this.deadline);
    this.input.signal?.removeEventListener("abort", this.onAbort);
    await this.removeHandles(this.handles.splice(0));
  }

  private async rejectAttempt(error: Error): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.cleanup();
    this.reject(error);
  }

  private async settle(value: () => NativePhoneVerificationResult | Promise<NativePhoneVerificationResult>): Promise<void> {
    if (this.settled || this.eventClaimed) return;
    this.eventClaimed = true;
    // Competing provider events detach, while cancellation and the deadline
    // remain active through restoration. A late result cannot publish success.
    await this.removeHandles(this.handles.splice(0));
    if (this.settled) return;
    try {
      const result = await value();
      if (this.settled) return;
      this.settled = true;
      await this.cleanup();
      this.resolve(result);
    } catch (error) {
      await this.rejectAttempt(this.port.normalizeError(error));
    }
  }

  private async retainHandle(pending: Promise<Handle>): Promise<boolean> {
    const handle = await pending;
    if (this.settled || this.eventClaimed) {
      await this.removeHandles([handle]);
      return false;
    }
    this.handles.push(handle);
    return true;
  }

  private admitsEvent(): boolean {
    return !this.input.fenceSessions || this.requestStarted;
  }

  private async listen(): Promise<boolean> {
    if (!(await this.retainHandle(this.port.onCodeSent(async event => {
      if (this.admitsEvent()) {
        await this.settle(() => ({ autoVerified: false, verificationId: event.verificationId }));
      }
    })))) return false;
    if (!(await this.retainHandle(this.port.onFailure(async event => {
      if (this.admitsEvent() && !this.eventClaimed) {
        await this.rejectAttempt(new Error(event.message || "Phone verification failed."));
      }
    })))) return false;
    return this.retainHandle(this.port.onCompleted(async () => {
      if (this.admitsEvent()) {
        await this.settle(async () => ({ autoVerified: true, user: await this.port.restoreSession() }));
      }
    }));
  }

  private async prepare(): Promise<void> {
    try {
      if (!(await this.port.isSignedIn())) {
        throw new Error(this.input.intent === "replace"
          ? "You must be signed in before changing the phone number."
          : "You must be signed in before linking a phone number.");
      }
      if (this.settled || !(await this.listen())) return;
      if (this.input.intent === "replace" && this.input.currentPhoneNumber) {
        await this.port.unlinkPhone();
        if (this.settled) return;
      }
      // Retained pre-dispatch events are discarded. The native plugin cannot
      // correlate an old event delivered after this dispatch.
      this.requestStarted = true;
      await this.port.sendPhone({ phoneNumber: this.input.phoneNumber,
        resendCode: this.input.resendCode, timeout: this.input.timeout });
    } catch (error) {
      if (!this.eventClaimed) await this.rejectAttempt(this.port.normalizeError(error));
    }
  }
}

type Admission = { token: symbol; signal?: AbortSignal; finished: Promise<void> };
let activeStart: Admission | null = null;

export async function startNativePhoneVerification(
  input: NativePhoneVerificationInput,
  port: NativePhoneVerificationPort,
): Promise<NativePhoneVerificationResult> {
  const pending = activeStart;
  if (input.fenceSessions && pending?.signal?.aborted) await pending.finished;
  if (input.fenceSessions && activeStart) {
    throw failure("phone-verification-in-progress", "A verification code is already being requested. Please wait.");
  }
  const token = Symbol("native-phone-start");
  let release!: () => void;
  const finished = new Promise<void>(done => { release = done; });
  if (input.fenceSessions) activeStart = { token, signal: input.signal, finished };
  try {
    return await new NativePhoneStart(input, port).run();
  } finally {
    if (activeStart?.token === token) activeStart = null;
    release();
  }
}
