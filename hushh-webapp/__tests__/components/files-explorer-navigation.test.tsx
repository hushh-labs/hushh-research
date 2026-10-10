import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, fileEntry, session } from "../fixtures/files-workspace";
import { FilesWorkspace } from "@/components/files/files-workspace";
import type { FileEntry } from "@/lib/files/service";
import { toast } from "sonner";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

describe("Files settings and local navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.vaultKey = "synthetic-memory-only";
    files.list.mockResolvedValue({ entries: [], cursor: "" });
    files.settings.mockResolvedValue({
      revision: 1,
      analysis: false,
      automatic: false,
      excluded: [],
      backgroundAvailable: true,
      backgroundProvider: "Azure OpenAI through your pod's managed identity",
      retention: {
        retentionLocked: true,
        softDeleteSeconds: 0,
        versioning: false,
        physicalDeletion: "not_requested_by_trash",
      },
    });
  });

  it("closes protected settings when the vault locks and does not reopen on unlock", async () => {
    const view = render(<FilesWorkspace />);
    await waitFor(() => expect(files.settings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "File settings" }));
    await screen.findByRole("dialog", { name: "File settings" });
    session.vaultKey = null;
    view.rerender(<FilesWorkspace />);
    await screen.findByText("Unlock your vault to open Files.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("switch")).toBeNull();
    session.vaultKey = "synthetic-memory-only";
    view.rerender(<FilesWorkspace />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "File settings" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps provider retention truthful and storage details secondary", async () => {
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.settings).toHaveBeenCalled());
    expect(screen.queryByText("Storage details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File settings" }));
    await screen.findByRole("dialog", { name: "File settings" });
    expect(screen.getByText(/duration is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Minimum retention: 0/)).toBeNull();
    expect(
      screen.getByRole("switch", {
        name: "Automatically organize new uploads",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByLabelText(/Storage warning|Estimated active hours/),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check storage" }));
    await screen.findByText(/101.00 GiB uploaded/);
    expect(screen.queryByText(/Illustrative subtotal/)).toBeNull();
  });

  it("keeps a refused settings change off and presents safe feedback", async () => {
    files.configure.mockRejectedValueOnce(
      new Error("FILES_AUTHORITY_UNAVAILABLE"),
    );
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.settings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "File settings" }));
    const analysis = await screen.findByRole("switch", {
      name: "Allow library analysis",
    });
    fireEvent.click(analysis);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not finish. Check your Files connection and try again.",
      ),
    );
    expect(analysis).toHaveAttribute("aria-checked", "false");
    expect(toast.error).not.toHaveBeenCalledWith("FILES_AUTHORITY_UNAVAILABLE");
  });

  it("permits withdrawal of automatic organization after provider loss without enabling it again", async () => {
    const settings = {
      revision: 4,
      analysis: true,
      automatic: true,
      excluded: [],
      backgroundAvailable: false,
    };
    files.settings.mockResolvedValue(settings);
    files.configure.mockImplementation(async (value) => {
      files.settings.mockResolvedValue({ ...value, revision: 5 });
      return value;
    });
    render(<FilesWorkspace />);
    await waitFor(() => expect(files.settings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "File settings" }));
    const automatic = await screen.findByRole("switch", {
      name: "Automatically organize new uploads",
    });
    expect(automatic).toBeEnabled();
    fireEvent.click(automatic);
    await waitFor(() =>
      expect(files.configure).toHaveBeenCalledExactlyOnceWith(
        { ...settings, automatic: false },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(automatic).toBeDisabled());
    fireEvent.click(automatic);
    expect(files.configure).toHaveBeenCalledTimes(1);
  });

  it("renames inline with Escape cancellation and one revision-bound save", async () => {
    const entry: FileEntry = fileEntry({
      id: "rename-file",
      name: "notes.txt",
      revision: 3,
    });
    files.list.mockResolvedValue({ entries: [entry], cursor: "" });
    render(<FilesWorkspace />);
    const actions = await screen.findByRole("button", {
      name: "Actions for notes.txt",
    });
    await waitFor(() => expect(actions).toBeEnabled());
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename", exact: true }),
    );
    const name = screen.getByRole("textbox", { name: "Name", exact: true });
    expect(name.closest('[data-file-row="rename-file"]')).not.toBeNull();
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "cancelled.txt" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(files.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Actions for notes.txt" }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename", exact: true }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed.txt" },
    });
    let settle!: () => void;
    files.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({});
        }),
    );
    const save = screen.getByRole("button", { name: "Save name" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() =>
      expect(files.mutate).toHaveBeenCalledExactlyOnceWith(
        entry,
        "rename",
        { name: "renamed.txt" },
        expect.any(AbortSignal),
      ),
    );
    settle();
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull(),
    );
  });

  it("does not offer organization inside an excluded folder", async () => {
    const folder: FileEntry = fileEntry({
      id: "excluded-folder",
      name: "Private",
      kind: "folder",
      size: 0,
      received: 0,
    });
    const entry: FileEntry = fileEntry({
      ...folder,
      id: "excluded-child",
      name: "notes.txt",
      originalName: "notes.txt",
      parent: folder.id,
    });
    files.list.mockImplementation(async (parent) => ({
      entries: parent === "root" ? [folder] : [entry],
      cursor: "",
    }));
    files.settings.mockResolvedValue({
      revision: 1,
      analysis: true,
      automatic: false,
      excluded: [folder.id],
      backgroundAvailable: true,
    });
    render(<FilesWorkspace />);
    const open = await screen.findByRole("button", {
      name: "Private",
      exact: true,
    });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const actions = await screen.findByRole("button", {
      name: "Actions for notes.txt",
    });
    await waitFor(() => expect(actions).toBeEnabled());
    fireEvent.keyDown(actions, { key: "Enter" });
    await screen.findByRole("menuitem", { name: "Exclude analysis" });
    expect(
      screen.queryByRole("menuitem", { name: "Organize", exact: true }),
    ).toBeNull();
    expect(files.organize).not.toHaveBeenCalled();
  });

  it("identifies activity on demand and uses the recorded cancellation outcome", async () => {
    const { FilesOrganizationHistory } = await vi.importActual<
      typeof import("@/components/files/files-organization-history")
    >("@/components/files/files-organization-history");
    const job = { id: "file-job", file: "file-entry", state: "queued" };
    files.history
      .mockResolvedValueOnce({ entries: [job], cursor: "" })
      .mockResolvedValueOnce({
        entries: [{ ...job, state: "completed" }],
        cursor: "",
      });
    files.entry.mockResolvedValue({ name: "organized-notes.txt" });
    files.organize.mockResolvedValue({ id: job.id, state: "completed" });
    render(<FilesOrganizationHistory ownerId="synthetic-owner" />);
    const show = await screen.findByRole("button", { name: "Show file name" });
    await waitFor(() => expect(show).toBeEnabled());
    expect(files.entry).not.toHaveBeenCalled();
    fireEvent.click(show);
    await screen.findByText("organized-notes.txt");
    expect(files.entry).toHaveBeenCalledExactlyOnceWith(
      "file-entry",
      expect.any(AbortSignal),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel organization" }),
    );
    await screen.findByText("completed");
    expect(
      screen.queryByRole("button", { name: "Cancel organization" }),
    ).toBeNull();
    expect(screen.queryByText("cancelled")).toBeNull();
  });

  it("unwinds the active folder edit before leaving the Files route", async () => {
    render(<FilesWorkspace />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(unwindBackLayer("/one/files")).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull(),
    );
    expect(unwindBackLayer("/one/files")).toBe(false);
    expect(files.createFolder).not.toHaveBeenCalled();
  });

  it("returns from a folder and Trash to the library before route Back", async () => {
    files.list.mockImplementation(async (parent) => ({
      entries:
        parent === "root"
          ? [
              fileEntry({
                id: "synthetic-folder",
                name: "Documents",
                kind: "folder",
                size: 0,
                received: 0,
              }) satisfies FileEntry,
            ]
          : [],
      cursor: "",
    }));
    render(<FilesWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Documents", exact: true }),
    );
    await waitFor(() => expect(unwindBackLayer("/one/files")).toBe(true));
    await screen.findByRole("button", { name: "Documents", exact: true });
    expect(unwindBackLayer("/one/files")).toBe(false);
    fireEvent.keyDown(screen.getByRole("button", { name: "Files options" }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Trash", exact: true }),
    );
    await waitFor(() => expect(unwindBackLayer("/one/files")).toBe(true));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Up one level" }),
      ).toBeDisabled(),
    );
    expect(unwindBackLayer("/one/files")).toBe(false);
    expect(files.mutate).not.toHaveBeenCalled();
  });

  it("requires the owner's confirmation before dispatching a Trash change", async () => {
    const entry: FileEntry = fileEntry({
      id: "synthetic-trash",
      name: "receipt.txt",
    });
    files.list.mockResolvedValue({ entries: [entry], cursor: "" });
    render(<FilesWorkspace />);
    const actions = await screen.findByRole("button", {
      name: "Actions for receipt.txt",
    });
    await waitFor(() => expect(actions).toBeEnabled());
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Trash", exact: true }),
    );
    await screen.findByRole("alertdialog");
    expect(files.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep file" }));
    expect(files.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Trash", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Move to Trash", exact: true }),
    );
    await waitFor(() =>
      expect(files.mutate).toHaveBeenCalledExactlyOnceWith(
        entry,
        "trash",
        { confirmed: true },
        expect.any(AbortSignal),
      ),
    );
  });
});
