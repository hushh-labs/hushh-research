import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKnowledgeHub } from "@/components/profile/memory-knowledge-hub";

const wikiOverviewMock = vi.fn();
const replaceMarkdownMock = vi.fn();

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ userId: "usr_hub_1" }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "a".repeat(64),
    vaultOwnerToken: "tok_hub_1",
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/lib/files/use-files-connection", () => ({
  useFilesConnection: () => ({ hosting: "shared", connectionError: "" }),
}));

vi.mock("@/lib/files/service", () => ({
  FilesService: {
    wikiOverview: (...args: unknown[]) => wikiOverviewMock(...args),
    wikiMigrateCohort: vi.fn(),
  },
}));

vi.mock("@/components/files/personal-wiki-panel", () => ({
  PersonalWikiPanel: () => <div data-testid="mock-personal-wiki-panel">Wiki workspace</div>,
}));

vi.mock("@/components/profile/communication-preferences-section", () => ({
  useCommunicationPreferencesEditor: () => ({
    userId: "usr_hub_1",
    unlocked: true,
    ready: true,
    loading: false,
    draft: {
      preferred_name: "Kushal",
      tone: "direct",
      length: "short",
      avoid_em_dashes: true,
    },
    dirty: false,
    saving: false,
    unavailable: false,
    suggested: false,
    error: null,
    draftRevision: 1,
    changeDraft: vi.fn(),
    changeField: vi.fn(),
    save: vi.fn(),
  }),
}));

vi.mock("@/components/profile/native-writing-style-editor", () => ({
  NativeWritingStyleEditor: () => <div data-testid="mock-writing-style-editor">Style editor</div>,
}));

vi.mock("@/lib/pkm/markdown-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pkm/markdown-memory")>();
  return {
    ...actual,
    replaceMarkdownMemoryDocument: (...args: unknown[]) => replaceMarkdownMock(...args),
  };
});

describe("MemoryKnowledgeHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wikiOverviewMock.mockResolvedValue({
      captureOptIn: true,
      migrationState: "wiki_primary_with_v1_rollback",
      migrationRevision: 2,
      pages: [
        { pageId: "wpg_1111222233334444", title: "Company Naming", folder: "topics", tldr: "Hussh", revision: 1, updatedAt: 1 },
        { pageId: "wpg_5555666677778888", title: "Travel", folder: "topics", tldr: "SFO", revision: 1, updatedAt: 1 },
      ],
      candidateReceipts: [],
    });
    replaceMarkdownMock.mockResolvedValue({ success: true, markdown: "# memory.md\n" });
  });

  it("renders streamlined Wiki and Core files (memory.md, identity.md, soul.md) and routes straight to /one/files", async () => {
    const navigateSpy = vi.fn();
    render(<MemoryKnowledgeHub onNavigate={navigateSpy} />);

    // Obsolete Live memory subtitle and modal controls are retired
    expect(
      screen.queryByText("Updates while the app is open and unlocked."),
    ).toBeNull();
    expect(screen.queryByText(/Live memory/i)).toBeNull();

    // Personal wiki & Core files rows are present and route straight into /one/files
    await waitFor(() =>
      expect(screen.getByTestId("memory-open-personal-wiki")).toHaveTextContent(
        "2 pages",
      ),
    );
    expect(screen.getByTestId("memory-open-core-memory")).toHaveTextContent(
      "memory.md",
    );
    expect(screen.getByTestId("memory-open-core-identity")).toHaveTextContent(
      "identity.md",
    );
    expect(screen.getByTestId("memory-open-core-soul")).toHaveTextContent(
      "soul.md",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Personal wiki in Files" }));
    expect(navigateSpy).toHaveBeenCalledWith("/one/files?folder=personal-wiki");

    fireEvent.click(screen.getByRole("button", { name: "Open memory.md in Files" }));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/one/files?folder=personal-wiki&doc=memory.md",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open identity.md in Files" }));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/one/files?folder=personal-wiki&doc=identity.md",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open soul.md in Files" }));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/one/files?folder=personal-wiki&doc=soul.md",
    );
  });
});
