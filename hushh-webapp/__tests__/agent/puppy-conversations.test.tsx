import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePuppyConversations } from "@/lib/agent/puppy-conversations";

describe("Puppy workspace conversation ownership", () => {
  it("creates, selects, renames and deletes independently without browser persistence", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => usePuppyConversations("owner-a"));
    act(() => result.current.create());
    const first = result.current.activeId!;
    act(() => result.current.create());
    const second = result.current.activeId!;
    expect(second).not.toBe(first);
    act(() => result.current.select(first));
    act(() => result.current.rename(first, "Example conversation"));
    expect(
      result.current.conversations.find((c) => c.id === first)?.title,
    ).toBe("Example conversation");
    act(() => result.current.remove(first));
    expect(result.current.activeId).toBe(second);
    expect(result.current.conversations).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("clears on owner change and sign-out and rejects old-owner callbacks", () => {
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string | null }) => usePuppyConversations(owner),
      { initialProps: { owner: "owner-a" as string | null } },
    );
    act(() => result.current.create());
    const oldCreate = result.current.create;
    rerender({ owner: "owner-b" });
    expect(result.current.conversations).toEqual([]);
    act(() => oldCreate());
    expect(result.current.conversations).toEqual([]);
    act(() => result.current.create());
    rerender({ owner: null });
    expect(result.current.activeId).toBeNull();
    expect(result.current.conversations).toEqual([]);
    act(() => result.current.create());
    expect(result.current.conversations).toEqual([]);
  });
});
