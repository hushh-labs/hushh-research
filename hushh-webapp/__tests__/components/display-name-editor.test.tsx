import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { User } from "firebase/auth";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DisplayNameEditor,
  normalizeDisplayName,
  validateDisplayName,
  useDisplayNameEditor,
} from "@/components/profile/display-name-editor";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ApiError } from "@/lib/services/api-client";
import { morphyToast } from "@/lib/morphy-ux/morphy";

vi.mock("@/lib/services/api-client", () => {
  class ApiError extends Error {
    status: number;
    payload?: unknown;
    constructor(message: string, status: number, payload?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  }
  const apiErrorCode = (error: unknown) => {
    if (!(error instanceof ApiError)) return null;
    const payload = error.payload as { detail?: { code?: string } } | undefined;
    return payload?.detail?.code ?? null;
  };
  return { ApiError, apiErrorCode };
});

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: vi.fn(() => null),
    updateDisplayName: vi.fn(),
    refreshCurrentUserIdentity: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const testUser = {
  uid: "user-1",
  displayName: "Jhumma Kumari",
  reload: vi.fn(async () => undefined),
} as unknown as User;

function typeName(value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
    target: { value },
  });
}

describe("display name validation mirrors the server rule", () => {
  it("collapses whitespace before measuring", () => {
    expect(normalizeDisplayName("  Jhumma   Kumari \n")).toBe("Jhumma Kumari");
  });

  it("requires 2-60 characters after normalisation", () => {
    expect(validateDisplayName("J")).toBe(
      "Display name must be between 2 and 60 characters.",
    );
    expect(validateDisplayName("   ")).toBe(
      "Display name must be between 2 and 60 characters.",
    );
    expect(validateDisplayName("a".repeat(61))).toBe(
      "Display name must be between 2 and 60 characters.",
    );
    expect(validateDisplayName("a".repeat(60))).toBeNull();
    expect(validateDisplayName("Jo")).toBeNull();
  });

  it("refuses links and handles", () => {
    for (const value of [
      "@jhumma",
      "jhumma@example.com",
      "https://example.com",
      "www.example.com",
      "http hello",
      "HTTPS://x",
    ]) {
      expect(validateDisplayName(value)).toBe(
        "Display name cannot contain links or handles.",
      );
    }
  });

  it("refuses control characters", () => {
    expect(validateDisplayName("Jhumma")).toBe(
      "Display name contains unsupported characters.",
    );
  });
});

describe("DisplayNameEditor", () => {
  beforeEach(() => {
    vi.mocked(AccountIdentityService.peekCachedIdentity).mockReset();
    vi.mocked(AccountIdentityService.peekCachedIdentity).mockReturnValue(null);
    vi.mocked(AccountIdentityService.updateDisplayName).mockReset();
    vi.mocked(AccountIdentityService.refreshCurrentUserIdentity).mockReset();
    vi.mocked(morphyToast.success).mockClear();
    useVoiceSessionStore.getState().effects.clear();
  });

  it("rejects a retained submit during layout teardown before provider admission", async () => {
    vi.mocked(AccountIdentityService.updateDisplayName).mockResolvedValue({ user_id: testUser.uid, display_name: "Changed Name" });
    let model!: ReturnType<typeof useDisplayNameEditor>;
    let completion: ReturnType<typeof model.submit> | undefined;
    function Consumer() {
      const editor = useDisplayNameEditor({ user: testUser, ownerId: testUser.uid });
      useLayoutEffect(() => { model = editor; });
      useLayoutEffect(() => () => { completion = model.submit(); }, []);
      return null;
    }
    const view = render(<Consumer />);
    act(() => model.changeDraft("Changed Name"));
    view.unmount();
    expect((await completion)?.kind).toBe("stale");
    expect(AccountIdentityService.updateDisplayName).not.toHaveBeenCalled();
  });

  it("starts from the current name and keeps Save off until it changes", () => {
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "Jhumma Kumari",
    );
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prefers the cached identity's stored name over the auth object", () => {
    vi.mocked(AccountIdentityService.peekCachedIdentity).mockReturnValue({
      data: { user_id: "user-1", display_name: "Stored Name" },
      isStale: false,
    } as never);
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "Stored Name",
    );
  });

  it("shows the mirrored rule inline and never calls the service for an invalid name", () => {
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);
    typeName("@jhumma");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Display name cannot contain links or handles.",
    );
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.submit(screen.getByTestId("display-name-editor"));
    expect(AccountIdentityService.updateDisplayName).not.toHaveBeenCalled();

    typeName("J");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Display name must be between 2 and 60 characters.",
    );
  });

  it("saves the normalised name and shows the RETURNED identity, not the input", async () => {
    const onSaved = vi.fn();
    vi.mocked(AccountIdentityService.updateDisplayName).mockResolvedValue({
      user_id: "user-1",
      display_name: "Jhumma Kay",
    });
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} onSaved={onSaved} />);

    typeName("  Jhumma    Kumari-Two ");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(AccountIdentityService.updateDisplayName).toHaveBeenCalledWith(
        testUser,
        "Jhumma Kumari-Two",
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
        "Jhumma Kay",
      );
    });
    expect(screen.getByText(/Currently Jhumma Kay/)).toBeInTheDocument();
    expect(morphyToast.success).toHaveBeenCalledWith(
      "Your Hussh name is now Jhumma Kay.",
    );
    expect(onSaved).toHaveBeenCalledWith({
      user_id: "user-1",
      display_name: "Jhumma Kay",
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("never claims success when the response carries no name", async () => {
    const onSaved = vi.fn();
    vi.mocked(AccountIdentityService.updateDisplayName).mockResolvedValue(null);
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} onSaved={onSaved} />);

    typeName("New Name");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /couldn't read your new name back/i,
      );
    });
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "New Name",
    );
    expect(screen.getByText(/Currently Jhumma Kumari\./)).toBeInTheDocument();
    expect(morphyToast.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each(["save", "voice"] as const)("fences a late %s completion across an owner change and return", async (operation) => {
    let complete!: (identity: { user_id: string; display_name: string }) => void;
    const pending = new Promise<{ user_id: string; display_name: string }>(resolve => { complete = resolve; });
    vi.mocked(AccountIdentityService.updateDisplayName).mockReturnValue(pending);
    vi.mocked(AccountIdentityService.refreshCurrentUserIdentity).mockReturnValue(pending);
    const otherUser = { ...testUser, uid: "user-2", displayName: "Other Owner" } as User;
    const onSaved = vi.fn();
    const { rerender } = render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} onSaved={onSaved} />);
    if (operation === "save") {
      typeName("Pending Name");
      fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    } else {
      act(() => useVoiceSessionStore.getState().emitToolResult("update_display_name", {
        status: "updated", display_name: "Pending Name",
      }));
    }
    rerender(<DisplayNameEditor user={otherUser} ownerId={otherUser.uid} onSaved={onSaved} />);
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Other Owner");
    rerender(<DisplayNameEditor user={testUser} ownerId={testUser.uid} onSaved={onSaved} />);
    typeName("Current Draft");
    await act(async () => complete({ user_id: "user-1", display_name: "Old Completion" }));
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Current Draft");
    expect(onSaved).not.toHaveBeenCalled();
    expect(morphyToast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
  });

  it("does not apply a returned name belonging to another owner", async () => {
    const onSaved = vi.fn();
    vi.mocked(AccountIdentityService.updateDisplayName).mockResolvedValue({
      user_id: "user-2", display_name: "Other Owner's Name",
    });
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} onSaved={onSaved} />);
    typeName("Current Draft");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Current Draft");
    expect(onSaved).not.toHaveBeenCalled();
    expect(morphyToast.success).not.toHaveBeenCalled();
  });

  it("admits one pending submit even when two presentation callbacks outrun a render", async () => {
    let complete!: (identity: { user_id: string; display_name: string }) => void;
    vi.mocked(AccountIdentityService.updateDisplayName).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const { result } = renderHook(() => useDisplayNameEditor({ user: testUser, ownerId: testUser.uid }));
    act(() => result.current.changeDraft("New Name"));
    let first!: ReturnType<typeof result.current.submit>;
    let second!: ReturnType<typeof result.current.submit>;
    act(() => { first = result.current.submit(); second = result.current.submit(); });
    await act(async () => complete({ user_id: testUser.uid, display_name: "New Name" }));
    expect(AccountIdentityService.updateDisplayName).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toEqual({ kind: "busy" });
    await expect(first).resolves.toEqual({ kind: "saved", identity: { user_id: testUser.uid, display_name: "New Name" } });
  });

  it("rejects retained presentation callbacks after owner retirement, including A to B to A", async () => {
    const otherUser = { ...testUser, uid: "user-2", displayName: "Other Owner" } as User;
    const { result, rerender } = renderHook(({ user }) => useDisplayNameEditor({ user, ownerId: user.uid }), {
      initialProps: { user: testUser },
    });
    act(() => result.current.changeDraft("Old Draft"));
    const retired = result.current;
    rerender({ user: otherUser });
    rerender({ user: testUser });
    act(() => result.current.changeDraft("Current Draft"));
    await act(async () => {
      retired.changeDraft("Retired Edit");
      expect(await retired.submit()).toEqual({ kind: "stale" });
    });
    expect(result.current.draft).toBe("Current Draft");
    expect(AccountIdentityService.updateDisplayName).not.toHaveBeenCalled();
  });

  it("rejects a retained submit whose same-owner draft has been replaced", async () => {
    const { result } = renderHook(() => useDisplayNameEditor({ user: testUser, ownerId: testUser.uid }));
    act(() => result.current.changeDraft("First Name"));
    const oldSubmit = result.current.submit;
    act(() => result.current.changeDraft("Second Name"));
    await act(async () => {
      expect(await oldSubmit()).toEqual({ kind: "stale" });
    });
    expect(result.current.draft).toBe("Second Name");
    expect(AccountIdentityService.updateDisplayName).not.toHaveBeenCalled();
  });

  it.each(["edit", "save"] as const)("does not let a voice refresh overwrite a newer %s", async (operation) => {
    let complete!: (identity: { user_id: string; display_name: string }) => void;
    vi.mocked(AccountIdentityService.refreshCurrentUserIdentity).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    vi.mocked(AccountIdentityService.updateDisplayName).mockResolvedValue({ user_id: testUser.uid, display_name: "New Saved Name" });
    const { result } = renderHook(() => useDisplayNameEditor({ user: testUser, ownerId: testUser.uid }));
    act(() => useVoiceSessionStore.getState().emitToolResult("update_display_name", {
      status: "updated", display_name: "Voice Name",
    }));
    act(() => result.current.changeDraft("New Saved Name"));
    if (operation === "save") await act(async () => { await result.current.submit(); });
    await act(async () => complete({ user_id: testUser.uid, display_name: "Voice Name" }));
    expect(result.current.draft).toBe("New Saved Name");
    expect(result.current.shownName).toBe(operation === "save" ? "New Saved Name" : "Voice Name");
  });

  it("keeps a provider-confirmed voice name when its shadow still has the old name", async () => {
    vi.mocked(AccountIdentityService.refreshCurrentUserIdentity).mockResolvedValue({ user_id: testUser.uid, display_name: "Old Shadow" });
    const { result } = renderHook(() => useDisplayNameEditor({ user: testUser, ownerId: testUser.uid }));
    await act(async () => useVoiceSessionStore.getState().emitToolResult("update_display_name", {
      status: "committed_sync_pending", display_name: "Committed Name",
    }));
    expect(result.current.shownName).toBe("Committed Name");
    expect(result.current.draft).toBe("Committed Name");
  });

  it("does not let a superseded save close a newer confirmed voice presentation", async () => {
    let complete!: (identity: { user_id: string; display_name: string }) => void;
    vi.mocked(AccountIdentityService.updateDisplayName).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    vi.mocked(AccountIdentityService.refreshCurrentUserIdentity).mockResolvedValue({ user_id: testUser.uid, display_name: "New Voice Name" });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useDisplayNameEditor({ user: testUser, ownerId: testUser.uid, onSaved }));
    act(() => result.current.changeDraft("Pending Name"));
    let pending!: ReturnType<typeof result.current.submit>;
    act(() => { pending = result.current.submit(); });
    await act(async () => useVoiceSessionStore.getState().emitToolResult("update_display_name", {
      status: "updated", display_name: "New Voice Name",
    }));
    await act(async () => complete({ user_id: testUser.uid, display_name: "Pending Name" }));
    await expect(pending).resolves.toEqual({ kind: "stale" });
    expect(result.current.draft).toBe("New Voice Name");
    expect(result.current.saving).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows the server's 422 message inline and keeps the draft", async () => {
    vi.mocked(AccountIdentityService.updateDisplayName).mockRejectedValue(
      new ApiError("Display name looks like a handle.", 422, {
        detail: {
          code: "DISPLAY_NAME_INVALID",
          message: "Display name looks like a handle.",
        },
      }),
    );
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);

    typeName("Jhumma Two");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Display name looks like a handle.",
      );
    });
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "Jhumma Two",
    );
    expect(
      screen.getByRole("textbox", { name: "Display name" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(morphyToast.success).not.toHaveBeenCalled();
    expect(screen.getByText(/Currently Jhumma Kumari\./)).toBeInTheDocument();

    // Typing again clears the server message so the person is not nagged
    // about a name they have already moved on from.
    typeName("Jhumma Three");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a 503 without changing the shown name", async () => {
    vi.mocked(AccountIdentityService.updateDisplayName).mockRejectedValue(
      new ApiError("Identity provider is not configured.", 503, {
        detail: { code: "IDENTITY_PROVIDER_UNAVAILABLE" },
      }),
    );
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);
    typeName("Jhumma Two");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /couldn't reach the sign-in service/i,
      );
    });
    expect(screen.getByText(/Currently Jhumma Kumari\./)).toBeInTheDocument();
  });

  it("refreshes the shown name from an update_display_name voice result", async () => {
    vi.mocked(
      AccountIdentityService.refreshCurrentUserIdentity,
    ).mockResolvedValue({
      user_id: "user-1",
      display_name: "Voice Name",
    });
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);

    act(() => {
      useVoiceSessionStore.getState().emitToolResult("update_display_name", {
        status: "updated",
        display_name: "Voice Name",
        spoken_facts: ["Your Hussh name is now Voice Name."],
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
        "Voice Name",
      );
    });
    expect(
      AccountIdentityService.refreshCurrentUserIdentity,
    ).toHaveBeenCalledWith(testUser, { force: true, requireSuccess: true });
    // The screen refresh is the server's; no local toast is faked for it.
    expect(morphyToast.success).not.toHaveBeenCalled();
  });

  it("ignores voice results that are not a confirmed update", () => {
    render(<DisplayNameEditor user={testUser} ownerId={testUser.uid} />);
    act(() => {
      useVoiceSessionStore.getState().emitToolResult("update_display_name", {
        status: "invalid",
        reason_code: "display_name_invalid",
        display_name: "Should Not Show",
      });
      useVoiceSessionStore.getState().emitToolResult("get_profile", {
        status: "ok",
        display_name: "Also Not",
      });
    });
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "Jhumma Kumari",
    );
    expect(
      AccountIdentityService.refreshCurrentUserIdentity,
    ).not.toHaveBeenCalled();
  });

  it("renders Cancel only when asked and disables the field without a user", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <DisplayNameEditor user={testUser} ownerId={testUser.uid} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();

    rerender(<DisplayNameEditor user={null} ownerId={null} />);
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Display name" }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("");
  });
});
