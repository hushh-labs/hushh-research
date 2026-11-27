import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useMessageDraft } from "@/lib/direct-messages/use-message-draft";
import { MessagesDraftService } from "@/lib/services/messages-draft-service";

afterEach(() => vi.restoreAllMocks());
it.each(["new typing", ""])("late recovery cannot overwrite an editor change (%s)", async typed => {
  let resolve!: (text: string) => void;
  vi.spyOn(MessagesDraftService, "read").mockReturnValue(new Promise<string>(done => { resolve = done; }));
  vi.spyOn(MessagesDraftService, "write").mockResolvedValue(true);
  const { result, unmount } = renderHook(() => {
    const [value, setValue] = useState("");
    const control = useMessageDraft({ userId: "draft-hook-owner", scope: "a", vaultKey: "ab".repeat(32), enabled: true, value, setValue });
    return { value, control };
  });
  act(() => result.current.control.update(typed));
  await act(async () => resolve("older saved draft"));
  expect(result.current.value).toBe(typed);
  unmount();
});

it("late recovery from a previous selection cannot replace the current recipient", async () => {
  let resolve!: (text: string) => void;
  vi.spyOn(MessagesDraftService, "read")
    .mockReturnValueOnce(new Promise<string>(done => { resolve = done; }))
    .mockResolvedValueOnce("current recipient draft");
  const { result, rerender, unmount } = renderHook(({ scope }) => {
    const [value, setValue] = useState("");
    useMessageDraft({ userId: "draft-hook-owner", scope, vaultKey: "ab".repeat(32), enabled: true, value, setValue });
    return value;
  }, { initialProps: { scope: "a" } });
  rerender({ scope: "b" });
  await waitFor(() => expect(result.current).toBe("current recipient draft"));
  await act(async () => resolve("old recipient draft"));
  expect(result.current).toBe("current recipient draft");
  unmount();
});

it("persists typing entered before fresh history admission once the thread is ready", async () => {
  vi.spyOn(MessagesDraftService, "read").mockResolvedValue(null);
  const write = vi.spyOn(MessagesDraftService, "write").mockResolvedValue(true);
  const { result, rerender, unmount } = renderHook(({ enabled }) => {
    const [value, setValue] = useState("");
    const control = useMessageDraft({ userId: "draft-hook-owner", scope: "early", vaultKey: "ab".repeat(32), enabled, value, setValue });
    return { value, control };
  }, { initialProps: { enabled: false } });
  act(() => result.current.control.update("typed while loading"));
  expect(write).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.control.status).toBe("Draft saved"));
  expect(write.mock.calls[0][3]).toBe("typed while loading");
  unmount();
});

it("warns before browser unload while the latest draft write is pending", async () => {
  vi.spyOn(MessagesDraftService, "read").mockResolvedValue(null);
  let resolve!: (saved: boolean) => void;
  vi.spyOn(MessagesDraftService, "write").mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
  const { result, unmount } = renderHook(() => {
    const [value, setValue] = useState("");
    return useMessageDraft({ userId: "draft-hook-owner", scope: "reload", vaultKey: "ab".repeat(32), enabled: true, value, setValue });
  });
  act(() => result.current.update("pending text"));
  const pending = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pending);
  expect(pending.defaultPrevented).toBe(true);
  await act(async () => resolve(true));
  const saved = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(saved);
  expect(saved.defaultPrevented).toBe(false);
  unmount();
});
