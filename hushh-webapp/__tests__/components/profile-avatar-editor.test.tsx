import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileAvatarEditor } from "@/components/profile/profile-avatar-editor";
import { pickAvatarDataUrl } from "@/lib/profile/avatar-capture";
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

vi.mock("@/hooks/use-effective-avatar-url", () => ({
  useEffectiveAvatarUrl: () => null,
}));

vi.mock("@/lib/profile/avatar-capture", () => ({
  pickAvatarDataUrl: vi.fn(),
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
    vi.mocked(pickAvatarDataUrl).mockResolvedValue(imageDataUrl);
    vi.mocked(AccountIdentityService.uploadAvatar).mockResolvedValue(null);

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
    vi.mocked(pickAvatarDataUrl).mockResolvedValue(imageDataUrl);
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
