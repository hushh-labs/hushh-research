import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileAvatarEditor } from "@/components/profile/profile-avatar-editor";
import { pickAvatar } from "@/lib/profile/avatar-capture";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";

const testUser = {
  displayName: "Jhumma Kumari",
  photoURL: null,
  uid: "user-1",
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: testUser }),
}));

const avatarState = vi.hoisted(() => ({ url: null as string | null }));

vi.mock("@/hooks/use-effective-avatar-url", () => ({
  useEffectiveAvatarUrl: () => avatarState.url,
}));

vi.mock("@/lib/profile/avatar-capture", () => ({
  pickAvatar: vi.fn(),
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
  },
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: () => false,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    error: vi.fn(),
    promise: vi.fn(),
  },
}));

describe("ProfileAvatarEditor", () => {
  it("lets the camera badge pick and upload a profile photo directly", async () => {
    const imageDataUrl = "data:image/jpeg;base64,profile-photo";
    vi.mocked(pickAvatar).mockResolvedValue({ kind: "selected", dataUrl: imageDataUrl });
    vi.mocked(AccountIdentityService.uploadAvatar).mockResolvedValue({
      user_id: "user-1",
      display_name: "Test",
      custom_photo_url: imageDataUrl,
    } as never);

    render(<ProfileAvatarEditor />);

    fireEvent.click(
      screen.getByRole("button", { name: "Change profile photo" }),
    );

    await waitFor(() => {
      expect(AccountIdentityService.uploadAvatar).toHaveBeenCalledWith(
        testUser,
        imageDataUrl,
      );
    });
    expect(morphyToast.promise).toHaveBeenCalledWith(expect.any(Promise), {
      loading: "Updating photo...",
      success: "Profile photo updated.",
      error: expect.any(Function),
    });
  });

  it("shows the selected photo immediately while the upload is pending", async () => {
    const imageDataUrl = "data:image/jpeg;base64,pending-photo";
    let finishUpload: (() => void) | null = null;
    vi.mocked(pickAvatar).mockResolvedValue({ kind: "selected", dataUrl: imageDataUrl });
    vi.mocked(AccountIdentityService.uploadAvatar).mockReturnValue(
      new Promise((resolve) => {
        finishUpload = () => resolve(null);
      }),
    );

    render(<ProfileAvatarEditor />);

    fireEvent.click(
      screen.getByRole("button", { name: "Change profile photo" }),
    );

    await waitFor(() => {
      expect(screen.getByAltText("Jhumma Kumari")).toHaveAttribute(
        "src",
        imageDataUrl,
      );
    });

    finishUpload?.();
  });
});

describe("ProfileAvatarEditor truthful settlement", () => {
  it("does not report 'updated' when the upload resolves without an identity", async () => {
    // Graph observation 3: the avatar helper resolved null (no session, or a
    // response with no identity) and the promise toast still said updated.
    vi.mocked(pickAvatar).mockResolvedValue({
      kind: "selected",
      dataUrl: "data:image/jpeg;base64,x",
    });
    vi.mocked(AccountIdentityService.uploadAvatar).mockResolvedValue(null);
    vi.mocked(morphyToast.promise).mockClear();

    render(<ProfileAvatarEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Change profile photo" }));

    await waitFor(() => expect(morphyToast.promise).toHaveBeenCalledTimes(1));
    const [settled] = vi.mocked(morphyToast.promise).mock.calls[0] as [Promise<unknown>];
    await expect(settled).rejects.toThrow("Photo wasn't saved. Try again.");
  });

  it("a cancelled pick uploads nothing and shows no error", async () => {
    vi.mocked(pickAvatar).mockResolvedValue({ kind: "cancelled" });
    vi.mocked(AccountIdentityService.uploadAvatar).mockClear();
    vi.mocked(morphyToast.error).mockClear();
    vi.mocked(morphyToast.promise).mockClear();

    render(<ProfileAvatarEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Change profile photo" }));

    await waitFor(() => expect(pickAvatar).toHaveBeenCalled());
    expect(AccountIdentityService.uploadAvatar).not.toHaveBeenCalled();
    expect(morphyToast.error).not.toHaveBeenCalled();
    expect(morphyToast.promise).not.toHaveBeenCalled();
  });

  it("a plugin failure names only that the picker did not open, and uploads nothing", async () => {
    vi.mocked(pickAvatar).mockResolvedValue({ kind: "failed", reason: "plugin" });
    vi.mocked(AccountIdentityService.uploadAvatar).mockClear();
    vi.mocked(morphyToast.error).mockClear();

    render(<ProfileAvatarEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Change profile photo" }));

    await waitFor(() =>
      expect(morphyToast.error).toHaveBeenCalledWith("Couldn't open your photos. Try again."),
    );
    expect(AccountIdentityService.uploadAvatar).not.toHaveBeenCalled();
  });

  it("does not report 'removed' when removal resolves without an identity", async () => {
    avatarState.url = "data:image/jpeg;base64,current";
    try {
      vi.mocked(AccountIdentityService.removeAvatar).mockResolvedValue(null);
      vi.mocked(morphyToast.promise).mockClear();

      render(<ProfileAvatarEditor />);
      fireEvent.click(screen.getByRole("button", { name: "Profile photo options" }));
      fireEvent.click(await screen.findByRole("button", { name: /remove photo/i }));

      await waitFor(() => expect(morphyToast.promise).toHaveBeenCalledTimes(1));
      const [settled] = vi.mocked(morphyToast.promise).mock.calls[0] as [Promise<unknown>];
      await expect(settled).rejects.toThrow("Photo wasn't removed. Try again.");
    } finally {
      avatarState.url = null;
    }
  });
});
