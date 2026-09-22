import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvePendingConsent: vi.fn(),
  denyPendingConsent: vi.fn(),
  revokeConsent: vi.fn(),
  onConsentMutated: vi.fn(),
  toastPromise: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    promise: mocks.toastPromise,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "vault-key",
    getVaultOwnerToken: () => "vault-owner-token",
  }),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    approvePendingConsent: mocks.approvePendingConsent,
    denyPendingConsent: mocks.denyPendingConsent,
    revokeConsent: mocks.revokeConsent,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated },
}));

vi.mock("@/lib/consent/export-builder", () => ({
  ConsentExportNoDataError: class ConsentExportNoDataError extends Error {},
  buildConsentExportForScope: vi.fn(),
}));

vi.mock("@/lib/vault/export-encrypt", () => ({
  generateExportKey: vi.fn(async () => "export-key"),
  encryptForExport: vi.fn(async () => ({
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  })),
  wrapExportKeyForConnector: vi.fn(),
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

import { useConsentActions, type PendingConsent } from "@/lib/consent";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function consent(id = "req-1"): PendingConsent {
  return {
    id,
    developer: "Macy's CRM",
    scope: "crm.profile.update",
    requestedAt: Date.now(),
  };
}

describe("useConsentActions async action locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates approve calls for the same request while in flight", async () => {
    const pending = deferredResponse();
    mocks.approvePendingConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleApprove(consent("req-approve"));
      second = result.current.handleApprove(consent("req-approve"));
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isRequestBusy("req-approve")).toBe(true),
    );
    await waitFor(() => expect(mocks.approvePendingConsent).toHaveBeenCalledTimes(1));

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isRequestBusy("req-approve")).toBe(false),
    );
    expect(mocks.onConsentMutated).toHaveBeenCalledWith("user-1");
  });

  it("deduplicates deny calls for the same request while in flight", async () => {
    const pending = deferredResponse();
    mocks.denyPendingConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleDeny("req-deny");
      second = result.current.handleDeny("req-deny");
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isRequestBusy("req-deny")).toBe(true),
    );
    expect(mocks.denyPendingConsent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isRequestBusy("req-deny")).toBe(false),
    );
  });

  it("deduplicates revoke calls for the same scope while in flight", async () => {
    const pending = deferredResponse();
    mocks.revokeConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleRevoke("attr.shopping.*");
      second = result.current.handleRevoke("attr.shopping.*");
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isScopeBusy("attr.shopping.*")).toBe(true),
    );
    expect(mocks.revokeConsent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ lockVault: false }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isScopeBusy("attr.shopping.*")).toBe(false),
    );
  });
});

type ToastPromiseOptions = {
  loading: string;
  success: string | ((value: unknown) => string);
  error: string | ((error: Error) => string);
};

function lastToastPromise(): { promise: Promise<unknown>; options: ToastPromiseOptions } {
  const call = mocks.toastPromise.mock.calls.at(-1);
  if (!call) throw new Error("toast.promise was not called");
  return { promise: call[0] as Promise<unknown>, options: call[1] as ToastPromiseOptions };
}

function renderSuccess(options: ToastPromiseOptions, value: unknown): string {
  return typeof options.success === "function" ? options.success(value) : options.success;
}

function renderError(options: ToastPromiseOptions, error: Error): string {
  return typeof options.error === "function" ? options.error(error) : options.error;
}

describe("useConsentActions owner-facing toasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says what allowing did, in plain words and without an emoji", async () => {
    mocks.approvePendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleApprove(consent("req-allow"));
    });

    const { promise, options } = lastToastPromise();
    expect(options.loading).toBe("Allowing...");
    const resolved = await promise;
    expect(renderSuccess(options, resolved)).toBe("Allowed. They can open it now.");
    expect(renderSuccess(options, resolved)).not.toMatch(/[✅❌\u{1f512}]/u);
  });

  it("never shows a raw 400 body when allowing fails", async () => {
    mocks.approvePendingConsent.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: "psycopg2.errors.UndefinedColumn: column consent_requests.expiry does not exist",
        }),
        { status: 400 },
      ),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleApprove(consent("req-allow-fail"));
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    const shown = renderError(options, error as Error);
    expect(shown).toBe("Could not allow this. Nothing was shared.");
    expect(shown).not.toMatch(/psycopg2|column|detail/i);
  });

  it("maps a short, marker-free backend refusal to the owner sentence", async () => {
    // "This request has already expired." is safe by the marker rule, but it
    // is still the backend's sentence. Only text this hook wrote may reach the
    // owner; the thrown error keeps the backend's words for the console.
    mocks.approvePendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "This request has already expired." }), {
        status: 400,
      }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleApprove(consent("req-allow-expired"));
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect((error as Error).message).toBe("This request has already expired.");
    expect(renderError(options, error as Error)).toBe("Could not allow this. Nothing was shared.");
  });

  it("lets a sentence the hook wrote for the owner through", async () => {
    // A developer request that arrived without a connector public key cannot
    // be allowed; the hook says so in its own words before any network call.
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleApprove({
        ...consent("req-allow-no-key"),
        metadata: { request_source: "developer_api_v1" },
      });
    });

    expect(mocks.approvePendingConsent).not.toHaveBeenCalled();
    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(renderError(options, error as Error)).toBe(
      "This app needs to send the request again before you can allow it.",
    );
  });

  it("says there is nothing to share instead of the builder's sentence", async () => {
    const { buildConsentExportForScope, ConsentExportNoDataError } = await import(
      "@/lib/consent/export-builder"
    );
    vi.mocked(buildConsentExportForScope).mockRejectedValueOnce(
      new ConsentExportNoDataError("Private analysis source material cannot be exported."),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleApprove({
        ...consent("req-allow-empty"),
        scope: "attr.shopping.*",
      });
    });

    expect(mocks.approvePendingConsent).not.toHaveBeenCalled();
    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    const shown = renderError(options, error as Error);
    expect(shown).toBe("There is nothing to share for this yet. Nothing was shared.");
    expect(shown).not.toMatch(/export|PKM/i);
  });

  it("says what declining did", async () => {
    mocks.denyPendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleDeny("req-decline");
    });

    const { promise, options } = lastToastPromise();
    expect(options.loading).toBe("Declining...");
    expect(renderSuccess(options, await promise)).toBe("Declined. Nothing was shared.");
  });

  it("falls back to a plain sentence when declining fails with an empty body", async () => {
    mocks.denyPendingConsent.mockResolvedValueOnce(new Response("", { status: 500 }));
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleDeny("req-decline-fail");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(renderError(options, error as Error)).toBe("Could not decline this. Try again.");
  });

  it("maps the deny route's own generic string to the owner sentence", async () => {
    // app/api/consent/pending/deny/route.ts always answers a backend failure
    // with this exact string. It is short and marker-free, so only a rule
    // that knows the route's vocabulary keeps it off the owner's screen.
    mocks.denyPendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Failed to deny consent" }), { status: 500 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleDeny("req-decline-route");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(renderError(options, error as Error)).toBe("Could not decline this. Try again.");
  });

  it("says that sharing stopped", async () => {
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ lockVault: false }), { status: 200 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleRevoke("attr.profile.city");
    });

    const { promise, options } = lastToastPromise();
    expect(options.loading).toBe("Stopping...");
    expect(renderSuccess(options, await promise)).toBe("Sharing stopped.");
  });

  it("never shows the revoke route's nested envelope, nor the backend sentence inside it", async () => {
    // app/api/consent/revoke/route.ts wraps the backend body verbatim as
    // { error: responseText }, and the backend raises HTTPException(detail=...),
    // so the body is JSON inside JSON. The peeled sentence stays on the thrown
    // error for the console; the owner reads the fallback.
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: JSON.stringify({ detail: "User ID does not match authenticated user" }),
        }),
        { status: 403 },
      ),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleRevoke("attr.profile.city");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("User ID does not match authenticated user");
    const shown = renderError(options, error as Error);
    expect(shown).not.toMatch(/[{}"]|detail|User ID/);
    expect(shown).toBe("Could not stop sharing. Try again.");
  });

  it("never shows the revoke route's own catch sentence", async () => {
    // app/api/consent/revoke/route.ts answers its own catch with
    // { error: `Internal server error: ${error}` }; short, marker-free, and a
    // developer's sentence all the same.
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Internal server error: TypeError: fetch failed" }),
        { status: 500 },
      ),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleRevoke("attr.profile.city");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    const shown = renderError(options, error as Error);
    expect(shown).not.toMatch(/internal|TypeError|fetch/i);
    expect(shown).toBe("Could not stop sharing. Try again.");
  });

  it("never shows the middleware's 401 detail", async () => {
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: JSON.stringify({ detail: "Token validation failed." }) }),
        { status: 401 },
      ),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleRevoke("attr.profile.city");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    const shown = renderError(options, error as Error);
    expect(shown).not.toMatch(/token/i);
    expect(shown).toBe("Could not stop sharing. Try again.");
  });

  it("falls back when the revoke route hands over an envelope it cannot unwrap", async () => {
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: JSON.stringify({ unexpected: true }) }), {
        status: 500,
      }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    await act(async () => {
      await result.current.handleRevoke("attr.profile.email");
    });

    const { promise, options } = lastToastPromise();
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(renderError(options, error as Error)).toBe("Could not stop sharing. Try again.");
  });
});

/**
 * A quiet caller owns the reporting and may put the thrown message in front
 * of the owner (the chat transcript does), so the rejection must carry the
 * owner sentence, with the backend's own words kept on `cause` for the
 * console. The old quiet path rethrew the peeled backend error as-is, which
 * put "Token validation failed." in the transcript.
 */
describe("useConsentActions quiet rejections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function rejection(run: () => Promise<void>): Promise<Error> {
    let caught: unknown = null;
    await act(async () => {
      try {
        await run();
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    return caught as Error;
  }

  it("rejects an allow with the owner sentence and keeps the 401 detail as cause", async () => {
    mocks.approvePendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Token validation failed." }), { status: 401 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    const error = await rejection(() =>
      result.current.handleApprove(consent("req-quiet-allow"), { quiet: true }),
    );

    expect(error.message).toBe("Could not allow this. Nothing was shared.");
    expect(error.message).not.toMatch(/token/i);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("Token validation failed.");
    expect(mocks.toastPromise).not.toHaveBeenCalled();
    expect(result.current.isRequestBusy("req-quiet-allow")).toBe(false);
  });

  it("lets a sentence the hook wrote for the owner through under quiet", async () => {
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    const error = await rejection(() =>
      result.current.handleApprove(
        { ...consent("req-quiet-no-key"), metadata: { request_source: "developer_api_v1" } },
        { quiet: true },
      ),
    );

    expect(mocks.approvePendingConsent).not.toHaveBeenCalled();
    expect(error.message).toBe(
      "This app needs to send the request again before you can allow it.",
    );
  });

  it("rejects a decline with the owner sentence, never the route's string", async () => {
    mocks.denyPendingConsent.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Failed to deny consent" }), { status: 500 }),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    const error = await rejection(() =>
      result.current.handleDeny("req-quiet-decline", { quiet: true }),
    );

    expect(error.message).toBe("Could not decline this. Try again.");
    expect((error.cause as Error).message).toBe("Failed to deny consent");
    expect(mocks.toastPromise).not.toHaveBeenCalled();
  });

  it("rejects a revoke with the owner sentence and the nested detail as cause", async () => {
    mocks.revokeConsent.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: JSON.stringify({ detail: "Token validation failed." }) }),
        { status: 401 },
      ),
    );
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));

    const error = await rejection(() =>
      result.current.handleRevoke("attr.profile.city", null, { quiet: true }),
    );

    expect(error.message).toBe("Could not stop sharing. Try again.");
    expect(error.message).not.toMatch(/[{}"]|detail|token/i);
    expect((error.cause as Error).message).toBe("Token validation failed.");
    expect(mocks.toastPromise).not.toHaveBeenCalled();
  });
});
