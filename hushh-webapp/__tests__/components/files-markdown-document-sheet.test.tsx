// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({
  customNativePresentationEnabled: () => false,
}));
vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: () => ({ userId: "owner-1", generation: 1 }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 1,
}));
vi.mock("@/lib/navigation/back-layers", () => ({
  useBackLayer: () => undefined,
}));
vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { FilesMarkdownDocumentSheet } from "@/components/files/files-markdown-document-sheet";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilesMarkdownDocumentSheet", () => {
  it("switches between Preview, Source, and Edit for core markdown documents and saves updates", async () => {
    const onSaveCore = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();

    render(
      <FilesMarkdownDocumentSheet
        open
        onClose={onClose}
        onSaveCore={onSaveCore}
        target={{
          kind: "core",
          docId: "memory.md",
          title: "memory.md",
          subtitle: "Durable agent memory",
          markdown: "# Memory\n- Prefers espresso\n",
          storedMarkdown: "# Memory\n- Prefers espresso\n",
          persisted: true,
          updatedAt: "2026-11-17T10:00:00.000Z",
          isDefaultTemplate: false,
        }}
      />,
    );

    expect(screen.getByText("Prefers espresso")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Source/i }));
    expect(screen.getByLabelText("Filter source lines")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));
    const editor = screen.getByLabelText("memory.md content");
    fireEvent.change(editor, { target: { value: "# Memory\n- Prefers matcha\n" } });

    fireEvent.click(screen.getByRole("button", { name: "Save memory.md" }));

    await waitFor(() => {
      expect(onSaveCore).toHaveBeenCalledWith({
        docId: "memory.md",
        markdown: "# Memory\n- Prefers matcha\n",
        expectedStoredMarkdown: "# Memory\n- Prefers espresso\n",
        expectedPersisted: true,
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Preview/i })).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("edits and saves a personal wiki note through onSaveWiki", async () => {
    const onSaveWiki = vi.fn().mockResolvedValue(true);

    render(
      <FilesMarkdownDocumentSheet
        open
        initialMode="edit"
        onClose={vi.fn()}
        onSaveWiki={onSaveWiki}
        target={{
          kind: "wiki",
          page: {
            pageId: "travel-prefs",
            slug: "travel-prefs",
            title: "Travel preferences",
            tldr: "Window seat on flights",
            body: "## Flights\n- Window seat",
            kind: "topic",
            statusAsOf: "2026-11-17",
            revision: 4,
            claims: [],
          },
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Travel & Flights" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Quiet cabin window" } });
    fireEvent.change(screen.getByLabelText("Details"), { target: { value: "## Flights\n- Aisle on long haul" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSaveWiki).toHaveBeenCalledWith({
        pageId: "travel-prefs",
        expectedRevision: 4,
        title: "Travel & Flights",
        tldr: "Quiet cabin window",
        body: "## Flights\n- Aisle on long haul",
      });
    });
  });
});
