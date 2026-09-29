import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilesWorkspace } from "@/components/files/files-workspace";
import type { FileEntry } from "@/lib/files/service";

const files = vi.hoisted(() => ({
  list: vi.fn(async () => ({ entries: [] as FileEntry[], cursor: "" })),
  settings: vi.fn(async () => ({
    revision: 1,
    analysis: false,
    automatic: false,
    excluded: [],
  })),
  createFolder: vi.fn(async () => ({})),
  upload: vi.fn(),
}));
vi.mock("@/lib/files/service", () => ({ FilesService: files }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "synthetic-owner" } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "synthetic-memory-only" }),
}));
vi.mock("@/components/profile/pkm-settings-shell", () => ({
  PkmSettingsShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/files/files-settings-panel", () => ({
  FilesSettingsPanel: () => null,
}));
vi.mock("@/components/files/files-organization-history", () => ({
  FilesOrganizationHistory: () => null,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: vi.fn(async () => ({ filesActivationAvailable: false })) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("Files form submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.list.mockResolvedValue({ entries: [], cursor: "" });
    files.upload.mockReset();
  });
  it("submits a new folder from Save using the shared button's real behavior", async () => {
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.list).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: "New folder", exact: true }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Name", exact: true }),
      {
        target: { value: "Synthetic folder" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() =>
      expect(files.createFolder).toHaveBeenCalledExactlyOnceWith(
        "Synthetic folder",
        "root",
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Name", exact: true }),
      ).toBeNull(),
    );
  });

  it("discovers an interrupted upload and resumes its retained file identity", async () => {
    const entry: FileEntry = {
      id: "synthetic-file",
      name: "upload.txt",
      originalName: "upload.txt",
      parent: "root",
      kind: "file",
      size: 8,
      received: 4,
      receivedHash: "synthetic-hash",
      state: "uploading",
      revision: 2,
    };
    files.upload
      .mockImplementationOnce(async () => {
        files.list.mockResolvedValue({ entries: [entry], cursor: "" });
        throw new TypeError("Connection interrupted");
      })
      .mockResolvedValueOnce({ ...entry, state: "ready" });
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.list).toHaveBeenCalled());
    const input = screen.getByLabelText("Choose a file to upload");
    const file = new File(["12345678"], "upload.txt");
    fireEvent.change(input, { target: { files: [file] } });
    const resume = await screen.findByRole("button", {
      name: "Resume upload",
      exact: true,
    });
    await waitFor(() => expect(resume).not.toBeDisabled());
    fireEvent.click(resume);
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(files.upload).toHaveBeenCalledTimes(2));
    expect(files.upload.mock.calls[1][4]).toEqual(entry);
    expect(files.createFolder).not.toHaveBeenCalled();
  });
});
