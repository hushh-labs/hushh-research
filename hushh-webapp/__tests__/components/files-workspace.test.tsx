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
  mutate: vi.fn(async () => ({})),
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
    files.list.mockReset();
    files.list.mockResolvedValue({ entries: [], cursor: "" });
    files.mutate.mockResolvedValue({});
    files.upload.mockReset();
  });
  it("waits for the initial library read before enabling file actions", async () => {
    let completeRead!: (value: { entries: FileEntry[]; cursor: string }) => void;
    files.list.mockImplementationOnce(
      () => new Promise((resolve) => { completeRead = resolve; }),
    );
    render(<FilesWorkspace />);
    const create = screen.getByRole("button", { name: "New folder", exact: true });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(files.createFolder).not.toHaveBeenCalled();
    completeRead({ entries: [], cursor: "" });
    await waitFor(() => expect(create).toBeEnabled());
  });
  it("serializes the two initial reads for a one-slot owner pod", async () => {
    let completeRead!: (value: { entries: FileEntry[]; cursor: string }) => void;
    files.list.mockImplementationOnce(
      () => new Promise((resolve) => { completeRead = resolve; }),
    );
    render(<FilesWorkspace />);
    expect(files.settings).not.toHaveBeenCalled();
    completeRead({ entries: [], cursor: "" });
    await waitFor(() => expect(files.settings).toHaveBeenCalledTimes(1));
  });
  it("recovers one failed cold library read without changing pod authority", async () => {
    files.list.mockRejectedValueOnce(new TypeError("Connection interrupted"));
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.list).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled(),
    );
    expect(
      screen.queryByText(/Your private Files library is not connected/),
    ).toBeNull();
  });
  it("shows the connection action after bounded transient retries fail", async () => {
    files.list.mockRejectedValue(new TypeError("Cold connection"));
    render(<FilesWorkspace />);
    await screen.findByText(/Your private Files library is not connected/, {}, { timeout: 5000 });
    expect(files.list).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
  });
  it("does not retry an authorization refusal", async () => {
    files.list.mockRejectedValueOnce(new Error("POD_DIRECT_OWNER_MISMATCH"));
    render(<FilesWorkspace />);
    await screen.findByText(/Your private Files library is not connected/);
    expect(files.list).toHaveBeenCalledTimes(1);
  });
  it("explains when an existing pod has not enabled Files", async () => {
    files.list.mockRejectedValueOnce(new Error("FILES_NOT_ENABLED"));
    render(<FilesWorkspace />);
    await screen.findByText("Files is not enabled on this pod. Review setup below.");
    expect(files.list).toHaveBeenCalledTimes(1);
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

  it("moves into a nested folder discovered after an empty cursor page", async () => {
    const source: FileEntry = {
      id: "source-file", name: "source.txt", originalName: "source.txt",
      parent: "root", kind: "file", size: 8, received: 8,
      receivedHash: "synthetic-hash", state: "ready", revision: 3,
    };
    const later: FileEntry = {
      ...source, id: "later-folder", name: "Later", originalName: "Later",
      kind: "folder", size: 0, received: 0,
    };
    const nested: FileEntry = {
      ...later, id: "nested-folder", name: "Nested", originalName: "Nested",
      parent: later.id,
    };
    files.list
      .mockResolvedValueOnce({ entries: [source], cursor: "" })
      .mockResolvedValueOnce({ entries: [], cursor: "next-page" })
      .mockResolvedValueOnce({ entries: [later], cursor: "" })
      .mockResolvedValueOnce({ entries: [nested], cursor: "" })
      .mockResolvedValueOnce({ entries: [], cursor: "" });

    render(<FilesWorkspace />);
    const actions = await screen.findByRole("button", { name: "Actions for source.txt" });
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move" }));
    const more = await screen.findByRole("button", { name: "Load more folders" });
    expect(screen.getByRole("button", { name: "Move here" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open Later" })).toBeNull();
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("button", { name: "Open Later" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Nested" }));
    const moveHere = screen.getByRole("button", { name: "Move here" });
    await waitFor(() => expect(moveHere).toBeEnabled());
    fireEvent.click(moveHere);

    await waitFor(() => expect(files.mutate).toHaveBeenCalledExactlyOnceWith(
      source, "move", { parent: nested.id }, expect.any(AbortSignal),
    ));
    expect(files.list).toHaveBeenCalledWith("root", "next-page", false, expect.any(AbortSignal));
    expect(files.list).toHaveBeenCalledWith(later.id, "", false, expect.any(AbortSignal));
    expect(files.list).toHaveBeenCalledWith(nested.id, "", false, expect.any(AbortSignal));
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
