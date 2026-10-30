import { beforeEach, describe, expect, it, vi } from "vitest";
import { startNativePhoneVerification, NATIVE_PHONE_VERIFICATION_START_TIMEOUT_MS,
  type NativePhoneVerificationPort } from "@/lib/auth/native-phone-verification";
import { getPhoneReliabilityFlags } from "@/lib/auth/phone-reliability";

const mockAuth = { currentUser: null as any };
const FirebaseAuthentication = {
  addListener: vi.fn(), linkWithPhoneNumber: vi.fn(), getCurrentUser: vi.fn(),
};
const port: NativePhoneVerificationPort = {
  isSignedIn: async () => Boolean(mockAuth.currentUser || (await FirebaseAuthentication.getCurrentUser()).user),
  onCodeSent: callback => FirebaseAuthentication.addListener("phoneCodeSent", callback),
  onFailure: callback => FirebaseAuthentication.addListener("phoneVerificationFailed", callback),
  onCompleted: callback => FirebaseAuthentication.addListener("phoneVerificationCompleted", callback),
  unlinkPhone: vi.fn(),
  sendPhone: options => FirebaseAuthentication.linkWithPhoneNumber(options),
  restoreSession: vi.fn(),
  normalizeError: error => error instanceof Error ? error : new Error("Phone verification failed."),
};
function start(phoneNumber: string, options?: { signal?: AbortSignal }) {
  return startNativePhoneVerification({ phoneNumber, intent: "link", currentPhoneNumber: "",
    fenceSessions: getPhoneReliabilityFlags().sessionFencing, signal: options?.signal }, port);
}
describe("native phone verification lifecycle", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    FirebaseAuthentication.linkWithPhoneNumber.mockResolvedValue(undefined);
    FirebaseAuthentication.getCurrentUser.mockResolvedValue({ user: null });
  });
  it("@feature_auth_reliability @trace_loop ignores retained native phone events replayed before sending a fresh SMS", async () => {
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    const removals: ReturnType<typeof vi.fn>[] = [];
    mockAuth.currentUser = { uid: "native-user", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        // The plugin retains provider events until a listener consumes them.
        if (eventName === "phoneCodeSent") await callback({ verificationId: "expired-earlier-request" });
        if (eventName === "phoneVerificationFailed") await callback({ message: "earlier request failed" });
        const remove = vi.fn().mockResolvedValue(undefined);
        removals.push(remove);
        return { remove } as any;
      },
    );
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
      await listeners.phoneCodeSent({ verificationId: "fresh-request" });
    });

    await expect(start("+16505550101")).resolves.toEqual({
      autoVerified: false,
      verificationId: "fresh-request",
    });
    expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(1);
    expect(removals).toHaveLength(3);
    for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
  });

  it("@feature_auth_reliability @trace_loop does not admit overlapping native SMS requests into the same global event", async () => {
    const codeSentListeners: Array<(event: any) => void | Promise<void>> = [];
    mockAuth.currentUser = { uid: "native-user", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        if (eventName === "phoneCodeSent") codeSentListeners.push(callback);
        return { remove: vi.fn().mockResolvedValue(undefined) } as any;
      },
    );
    const first = start("+16505550101");
    await vi.waitFor(() => expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(1));
    const second = start("+16505550102");
    const outcomes = Promise.allSettled([first, second]);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    for (const listener of codeSentListeners) await listener({ verificationId: "first-request" });

    const results = await outcomes;
    expect(results[0]).toEqual({ status: "fulfilled", value: { autoVerified: false, verificationId: "first-request" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "phone-verification-in-progress" } });
    expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(1);

    // Provider failure must release admission for an explicit retry.
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(start("+16505550101")).rejects.toThrow("provider unavailable");
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockRejectedValueOnce(new Error("retry reached provider"));
    await expect(start("+16505550101")).rejects.toThrow("retry reached provider");
  });

  it.each([["true", "send"], ["false", "send"], ["true", "preflight"]])("@feature_auth_reliability @trace_loop releases a callback-free native start at its deadline (fencing=%s phase=%s)", async (sessionFencing, phase) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_PHONE_SESSION_FENCING_ENABLED", sessionFencing);
    vi.useFakeTimers();
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    const removals: ReturnType<typeof vi.fn>[] = [];
    mockAuth.currentUser = { uid: "first-owner", phoneNumber: null } as any;
    let finishPreflight: ((value: any) => void) | undefined;
    if (phase === "preflight") {
      mockAuth.currentUser = null;
      vi.mocked(FirebaseAuthentication.getCurrentUser).mockImplementationOnce(
        () => new Promise((resolve) => { finishPreflight = resolve; }),
      );
    }
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        const remove = vi.fn().mockResolvedValue(undefined);
        removals.push(remove);
        return { remove } as any;
      },
    );
    try {
      const finished = vi.fn();
      const outcome = start("+16505550101").then(
        (value) => { finished(); return { value, error: null }; },
        (error: unknown) => { finished(); return { value: null, error }; },
      );
      await vi.advanceTimersByTimeAsync(NATIVE_PHONE_VERIFICATION_START_TIMEOUT_MS - 1);
      expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(phase === "send" ? 1 : 0);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toHaveBeenCalledTimes(1);
      expect(await outcome).toMatchObject({ error: { code: "phone-verification-start-timeout" } });
      expect(removals).toHaveLength(phase === "send" ? 3 : 0);
      for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      finishPreflight?.({ user: { uid: "first-owner" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(removals).toHaveLength(phase === "send" ? 3 : 0);

      mockAuth.currentUser = { uid: "next-owner", phoneNumber: null } as any;
      vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
        await listeners.phoneCodeSent({ verificationId: "next-owner-fresh-request" });
      });
      await expect(start("+16505550102")).resolves.toEqual({
        autoVerified: false, verificationId: "next-owner-fresh-request",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("@feature_auth_reliability @trace_loop bounds stuck native listener removal before admitting a retry", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    const remove = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValue(undefined);
    mockAuth.currentUser = { uid: "native-owner", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        return { remove } as any;
      },
    );
    const controller = new AbortController();
    try {
      const cancelled = start("+16505550101", { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
        await listeners.phoneCodeSent({ verificationId: "retry-request" });
      });
      const retry = start("+16505550102");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(cancelled).resolves.toMatchObject({ code: "phone-verification-start-cancelled" });
      await expect(retry).resolves.toEqual({ autoVerified: false, verificationId: "retry-request" });
      expect(remove).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("@feature_auth_reliability @trace_loop cancels a native start and cleans a late listener without releasing its replacement", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    const lateRemove = vi.fn().mockResolvedValue(undefined);
    let finishRegistration!: (handle: { remove: typeof lateRemove }) => void;
    mockAuth.currentUser = { uid: "native-owner", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        return { remove: vi.fn().mockResolvedValue(undefined) } as any;
      },
    ).mockImplementationOnce(() => new Promise((resolve) => { finishRegistration = resolve; }));
    const controller = new AbortController();
    try {
      const cancelled = start("+16505550101", { signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(finishRegistration).toBeTypeOf("function");
      controller.abort();
      // The next owner starts immediately; admission waits for old cleanup.
      const replacement = start("+16505550102");
      await expect(cancelled).resolves.toMatchObject({ code: "phone-verification-start-cancelled" });
      await vi.advanceTimersByTimeAsync(0);
      expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(1);
      finishRegistration({ remove: lateRemove });
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRemove).toHaveBeenCalledTimes(1);
      await expect(start("+16505550103")).rejects.toMatchObject({
        code: "phone-verification-in-progress",
      });
      await listeners.phoneCodeSent({ verificationId: "replacement-request" });
      await expect(replacement).resolves.toEqual({ autoVerified: false, verificationId: "replacement-request" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("@feature_auth_reliability @trace_loop claims native auto-verification before a code-sent callback can publish a consumed code", async () => {
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    mockAuth.currentUser = { uid: "native-user", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        return { remove: vi.fn().mockResolvedValue(undefined) } as any;
      },
    );
    const verifiedUser = { uid: "native-user", phoneNumber: "+16505550101" } as any;
    let finishRestoration!: (user: any) => void;
    const restore = vi.spyOn(port, "restoreSession").mockImplementationOnce(
      () => new Promise((resolve) => { finishRestoration = resolve; }),
    );
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
      void listeners.phoneVerificationCompleted({});
      await listeners.phoneCodeSent({ verificationId: "already-consumed-request" });
    });

    try {
      const pending = start("+16505550101");
      await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
      finishRestoration(verifiedUser);
      await expect(pending).resolves.toEqual({ autoVerified: true, user: verifiedUser });
    } finally {
      restore.mockRestore();
    }
  });

  it.each(["deadline", "abort"])("@feature_auth_reliability @trace_loop releases stalled native auto-verification restoration on %s", async (stop) => {
    vi.useFakeTimers();
    const listeners: Record<string, (event: any) => void | Promise<void>> = {};
    mockAuth.currentUser = { uid: "first-owner", phoneNumber: null } as any;
    vi.mocked(FirebaseAuthentication.addListener).mockImplementation(
      async (eventName: string, callback: (event: any) => void | Promise<void>) => {
        listeners[eventName] = callback;
        return { remove: vi.fn().mockResolvedValue(undefined) } as any;
      },
    );
    let finishRestoration!: (user: any) => void;
    const restore = vi.spyOn(port, "restoreSession").mockImplementationOnce(
      () => new Promise((resolve) => { finishRestoration = resolve; }),
    );
    vi.mocked(FirebaseAuthentication.linkWithPhoneNumber).mockImplementationOnce(async () => {
      void listeners.phoneVerificationCompleted({});
    });
    const firstController = new AbortController();
    const nextController = new AbortController();
    try {
      const finished = vi.fn();
      const outcome = start("+16505550101", { signal: firstController.signal })
        .then((value) => { finished(); return { value, error: null }; },
          (error: unknown) => { finished(); return { value: null, error }; });
      await vi.advanceTimersByTimeAsync(0);
      expect(restore).toHaveBeenCalledTimes(1);
      if (stop === "abort") firstController.abort();
      else await vi.advanceTimersByTimeAsync(NATIVE_PHONE_VERIFICATION_START_TIMEOUT_MS);

      mockAuth.currentUser = { uid: "next-owner", phoneNumber: null } as any;
      const next = start("+16505550102", { signal: nextController.signal });
      void next.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toHaveBeenCalledTimes(1);
      expect(await outcome).toMatchObject({ error: { code: stop === "abort"
        ? "phone-verification-start-cancelled" : "phone-verification-start-timeout" } });
      expect(FirebaseAuthentication.linkWithPhoneNumber).toHaveBeenCalledTimes(2);

      // Finishing the retired restore must not publish success or clear the
      // next owner's admission token.
      finishRestoration({ uid: "first-owner", phoneNumber: "+16505550101" });
      await vi.advanceTimersByTimeAsync(0);
      await expect(start("+16505550103")).rejects.toMatchObject({
        code: "phone-verification-in-progress",
      });
      await listeners.phoneCodeSent({ verificationId: "next-owner-request" });
      await expect(next).resolves.toEqual({ autoVerified: false, verificationId: "next-owner-request" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      firstController.abort();
      nextController.abort();
      finishRestoration?.({ uid: "first-owner" });
      await vi.advanceTimersByTimeAsync(0);
      restore.mockRestore();
      vi.useRealTimers();
    }
  });

});
