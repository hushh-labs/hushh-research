import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DisplayNameEditor,
  normalizeDisplayName,
  validateDisplayName,
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

  it("starts from the current name and keeps Save off until it changes", () => {
    render(<DisplayNameEditor user={testUser} />);
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
    render(<DisplayNameEditor user={testUser} />);
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
      "Stored Name",
    );
  });

  it("shows the mirrored rule inline and never calls the service for an invalid name", () => {
    render(<DisplayNameEditor user={testUser} />);
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
    render(<DisplayNameEditor user={testUser} onSaved={onSaved} />);

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
    render(<DisplayNameEditor user={testUser} onSaved={onSaved} />);

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

  it("shows the server's 422 message inline and keeps the draft", async () => {
    vi.mocked(AccountIdentityService.updateDisplayName).mockRejectedValue(
      new ApiError("Display name looks like a handle.", 422, {
        detail: {
          code: "DISPLAY_NAME_INVALID",
          message: "Display name looks like a handle.",
        },
      }),
    );
    render(<DisplayNameEditor user={testUser} />);

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
    render(<DisplayNameEditor user={testUser} />);
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
    render(<DisplayNameEditor user={testUser} />);

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
    ).toHaveBeenCalledWith(testUser, { force: true });
    // The screen refresh is the server's; no local toast is faked for it.
    expect(morphyToast.success).not.toHaveBeenCalled();
  });

  it("ignores voice results that are not a confirmed update", () => {
    render(<DisplayNameEditor user={testUser} />);
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
      <DisplayNameEditor user={testUser} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();

    rerender(<DisplayNameEditor user={null} />);
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Display name" }),
    ).toBeDisabled();
  });
});
