import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useContactInvitations } from "../use-contact-invitations";
import type { InviteCandidate } from "../invitation-candidates";

const rows: InviteCandidate[] = [
  {
    id: "local",
    displayName: "Private",
    classification: "no_match",
    destinations: [{ kind: "phone", value: "+14155550101" }],
  },
];
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("clears retained recipients and rejects late reads after dismiss, resync and account replacement", () => {
  const { result, rerender } = renderHook(
    ({ userId }) => useContactInvitations(userId),
    { initialProps: { userId: "a" } },
  );
  let accept: ReturnType<typeof result.current.beginSync>;
  act(() => {
    accept = result.current.beginSync();
  });
  act(() => accept?.(rows));
  expect(result.current.candidates).toHaveLength(1);
  act(() => result.current.clear());
  act(() => accept?.(rows));
  expect(result.current.candidates).toEqual([]);
  act(() => {
    accept = result.current.beginSync();
  });
  act(() => {
    result.current.beginSync();
  });
  act(() => accept?.(rows));
  expect(result.current.candidates).toEqual([]);
  act(() => {
    accept = result.current.beginSync();
  });
  rerender({ userId: "b" });
  act(() => accept?.(rows));
  expect(result.current.candidates).toEqual([]);
});

it("discards an invitation link resolved after the session ends", async () => {
  const { result } = renderHook(() => useContactInvitations("a"));
  act(() => result.current.beginSync()?.(rows));
  let resolve!: (value: null) => void;
  let opening!: Promise<boolean>;
  act(() => {
    opening = result.current.open(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  });
  expect(result.current.active).toBe(true);
  act(() => result.current.clear());
  await act(async () => {
    resolve(null);
    await opening;
  });
  expect(result.current.active).toBe(false);
  expect(result.current.share).toBeNull();
  expect(result.current.error).toBeNull();
});

it("does not retain contacts in flag-off builds", () => {
  vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "false");
  const { result } = renderHook(() => useContactInvitations("a"));
  act(() => expect(result.current.beginSync()).toBeUndefined());
  expect(result.current.candidates).toEqual([]);
});

it("enables recipient selection without any rollout configuration", async () => {
  vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", undefined);
  const { result } = renderHook(() => useContactInvitations("a"));
  expect(result.current.enabled).toBe(true);
  act(() => result.current.beginSync()?.(rows));
  await act(async () => {
    await result.current.open(async () => ({
      title: "Join One",
      text: "Join me",
      url: "https://one.example",
      dialogTitle: "Invite",
    }));
  });
  expect(result.current.active).toBe(true);
  expect(result.current.candidates).toEqual(rows);
  expect(result.current.share?.url).toBe("https://one.example");
});

it("recovers from failed and timed-out preparation without losing contacts or accepting late results", async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useContactInvitations("a"));
  act(() => result.current.beginSync()?.(rows));
  const share = {
    title: "Invite",
    text: "Join me",
    url: "https://one.example",
    dialogTitle: "Invite",
  };
  let resolveOld!: (value: typeof share) => void;
  const prepare = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(share);
  let opening!: Promise<boolean>;
  act(() => {
    opening = result.current.open(prepare);
  });
  await act(async () => {
    await result.current.open(prepare);
  });
  expect(prepare).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    await opening;
  });
  expect(result.current.preparing).toBe(false);
  expect(result.current.error).toMatch(/retry/);
  await act(async () => {
    await result.current.retryPreparation();
  });
  expect(result.current.error).toMatch(/retry/);
  await act(async () => {
    await result.current.retryPreparation();
  });
  expect(result.current.share).toEqual(share);
  expect(result.current.candidates).toEqual(rows);
  await act(async () => {
    resolveOld({ ...share, url: "https://stale.example" });
  });
  expect(result.current.share).toEqual(share);
  act(() => result.current.clear());
  await act(async () => {
    await result.current.retryPreparation();
  });
  expect(prepare).toHaveBeenCalledTimes(3);
});

it("invalidates captured toast actions after session changes and unmount", () => {
  const { result, unmount } = renderHook(() => useContactInvitations("a"));
  act(() => result.current.beginSync()?.(rows));
  const oldToast = result.current.captureSession();
  expect(oldToast()).toBe(true);
  act(() => result.current.clear());
  expect(oldToast()).toBe(false);
  act(() => result.current.beginSync()?.(rows));
  const nextToast = result.current.captureSession();
  expect(nextToast()).toBe(true);
  unmount();
  expect(nextToast()).toBe(false);
});

it.each([
  { url: "javascript:alert(1)", text: "Join me" },
  { url: "not a link", text: "Join me" },
  { url: "https://one.example", text: "x".repeat(1980) },
])(
  "rejects unusable prepared messages before enabling the queue: $url",
  async ({ url, text }) => {
    const { result } = renderHook(() => useContactInvitations("a"));
    act(() => result.current.beginSync()?.(rows));
    const prepare = vi
      .fn()
      .mockResolvedValue({ title: "Invite", dialogTitle: "Invite", url, text });
    await act(async () => {
      await result.current.open(prepare);
    });
    expect(result.current.share).toBeNull();
    expect(result.current.error).toMatch(/retry/);
    expect(result.current.candidates).toEqual(rows);
  },
);
