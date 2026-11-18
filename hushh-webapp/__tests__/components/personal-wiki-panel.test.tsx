import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, session } from "../fixtures/files-workspace";

vi.mock("@/lib/pkm/agent-core-markdown-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pkm/agent-core-markdown-files")>();
  return {
    ...actual,
    peekCoreAgentMarkdownFile: vi.fn(() => null),
    loadCoreAgentMarkdownFile: vi.fn(async ({ docId }: { docId: "memory.md" | "identity.md" | "soul.md" }) => ({
      id: docId,
      markdown: `# ${docId}\n\nVerified personal notes.`,
      storedMarkdown: `# ${docId}\n\nVerified personal notes.`,
      persisted: true,
      isDefaultTemplate: false,
      updatedAt: "2026-11-18T10:00:00Z",
    })),
    saveCoreAgentMarkdownFile: vi.fn(async ({ docId, markdown }: { docId: "memory.md" | "identity.md" | "soul.md"; markdown: string }) => ({
      success: true,
      document: {
        id: docId,
        markdown,
        storedMarkdown: markdown,
        persisted: true,
        isDefaultTemplate: false,
        updatedAt: "2026-11-18T10:05:00Z",
      },
    })),
  };
});

import { FilesWorkspace } from "@/components/files/files-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

describe("PersonalWikiPanel in FilesWorkspace (Phase 5 #9370)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.vaultKey = "synthetic-memory-only";
    files.list.mockResolvedValue({ entries: [], cursor: "" });
    files.settings.mockResolvedValue({
      revision: 1,
      analysis: false,
      automatic: false,
      excluded: [],
    });
    files.wikiOverview.mockResolvedValue({
      captureOptIn: false,
      migrationState: "wiki_primary_with_v1_rollback",
      migrationRevision: 2,
      pages: [
        {
          pageId: "wpg_1111222233334444",
          title: "Travel Preferences",
          folder: "topics",
          tldr: "Prefers morning flights",
          revision: 3,
          updatedAt: 1_760_000_000_000,
        },
      ],
      candidateReceipts: [
        {
          receiptId: "wpr_aaaa1111bbbb2222",
          pageId: "wpg_1111222233334444",
          claimId: "wcl_1111222233334444",
          domain: "travel",
          statement: "Prefers aisle seats",
          state: "private_candidate",
        },
      ],
    });
    files.wikiPage.mockResolvedValue({
      pageId: "wpg_1111222233334444",
      title: "Travel Preferences",
      folder: "topics",
      tldr: "Prefers morning flights",
      body: "- Prefers morning flights from Austin.",
      revision: 3,
      statusAsOf: "2026-11-15",
      claims: [
        {
          claimId: "wcl_1111222233334444",
          statement: "Prefers morning flights from Austin",
          status: "active",
          observedAt: "2026-11-15",
          origins: ["Conversation · 2026-11-15"],
        },
      ],
    });
  });

  it("manages opt-in, candidate confirmation, unified Markdown sheet editing, Forget confirmation, Back unwind, and vault-lock closure without technical jargon", async () => {
    const view = render(<FilesWorkspace />);
    const wikiFolderButton = await screen.findByRole("button", {
      name: "Personal wiki",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled(),
    );

    fireEvent.click(wikiFolderButton);
    const wikiView = await screen.findByTestId("files-personal-wiki-view");
    await screen.findByText("Travel Preferences");

    // Verify calm consumer copy with zero internal identifier jargon
    expect(wikiView.textContent).not.toMatch(
      /PKM|manifest|wcl_|wsr_|wpr_|visibility_posture/i,
    );

    // 1. Toggle opt-in
    const optSwitch = screen.getByRole("switch", {
      name: "Remember from conversations",
    });
    expect(optSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(optSwitch);
    await waitFor(() =>
      expect(files.wikiSetOptIn).toHaveBeenCalledWith(
        true,
        expect.any(AbortSignal),
      ),
    );

    // 2. Confirm pending candidate update
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(files.wikiConfirmCandidate).toHaveBeenCalledWith(
        "wpr_aaaa1111bbbb2222",
        expect.any(AbortSignal),
      ),
    );

    // 2b. Import ChatGPT / Claude archive into encrypted Files then Personal Wiki
    files.upload.mockResolvedValueOnce({
      id: "f".repeat(32),
      name: "chatgpt-export.zip",
      originalName: "chatgpt-export.zip",
      parent: "root",
      kind: "file",
      size: 1024,
      received: 1024,
      receivedHash: "0".repeat(64),
      state: "ready",
      revision: 1,
    });
    const fileInput = screen.getByLabelText(
      "Choose ChatGPT or Claude export file",
    );
    const archiveFile = new File(["{}"], "chatgpt-export.zip", {
      type: "application/zip",
    });
    fireEvent.change(fileInput, { target: { files: [archiveFile] } });
    await waitFor(() =>
      expect(files.wikiImportArchive).toHaveBeenCalledWith(
        { fileId: "f".repeat(32), sourceProvider: "auto" },
        expect.any(AbortSignal),
      ),
    );

    // 3. Open note -> opens unified FilesMarkdownDocumentSheet in Preview first
    fireEvent.click(
      screen.getByRole("button", { name: "Open Travel Preferences" }),
    );
    await screen.findByTestId("files-markdown-document-sheet");
    expect(
      await screen.findByText(/From Conversation · 2026-11-15/),
    ).toBeInTheDocument();

    // Switch to Edit mode and save note
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Summary" }), {
      target: { value: "Updated travel summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(files.wikiSavePage).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: "wpg_1111222233334444",
          expectedRevision: 3,
          tldr: "Updated travel summary",
        }),
        expect.any(AbortSignal),
      ),
    );

    // Destructive Forget requires AlertDialog confirmation
    fireEvent.click(
      screen.getByRole("button", {
        name: "Forget Prefers morning flights from Austin",
      }),
    );
    await screen.findByRole("alertdialog");
    expect(files.wikiForgetClaim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forget fact" }));
    await waitFor(() =>
      expect(files.wikiForgetClaim).toHaveBeenCalledWith(
        {
          pageId: "wpg_1111222233334444",
          claimId: "wcl_1111222233334444",
        },
        expect.any(AbortSignal),
      ),
    );

    // Back unwinds the open Markdown document sheet back to Personal wiki folder
    expect(unwindBackLayer("/one/files")).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("files-markdown-document-sheet")).toBeNull(),
    );
    await screen.findByText("Travel Preferences");

    // Vault lock clears Files workspace cleanly with no lingering sheet/dialog
    session.vaultKey = null;
    view.rerender(<FilesWorkspace />);
    await screen.findByText("Unlock your vault to open Files.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes Personal wiki as a top-level folder inside Files and unwinds Back to root", async () => {
    render(<FilesWorkspace />);
    const wikiFolderButton = await screen.findByRole("button", {
      name: "Personal wiki",
    });
    fireEvent.click(wikiFolderButton);

    await screen.findByText("Travel Preferences");
    expect(screen.getByTestId("files-personal-wiki-view")).toBeInTheDocument();

    expect(unwindBackLayer("/one/files")).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId("files-personal-wiki-view")).toBeNull(),
    );
    expect(
      await screen.findByTestId("files-personal-wiki-folder"),
    ).toBeInTheDocument();
  });

  it("opens initialDoc core markdown sheet and keeps Core agent files usable even when remote wiki overview fails", async () => {
    files.wikiOverview.mockRejectedValueOnce(new Error("POD_UNAVAILABLE"));
    const onConsumed = vi.fn();

    render(
      <FilesWorkspace
        initialFolder="personal-wiki"
        initialDoc="memory.md"
        onInitialSelectionConsumed={onConsumed}
      />,
    );

    const sheet = await screen.findByTestId("files-markdown-document-sheet");
    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveTextContent("memory.md");

    expect(screen.getByTestId("wiki-core-doc-memory.md")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-core-doc-identity.md")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-core-doc-soul.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("memory.md content")).toBeInTheDocument();
    await waitFor(() => expect(onConsumed).toHaveBeenCalled());
  });
});
