import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKnowledgeHub } from "@/components/profile/memory-knowledge-hub";
import type { SoulMemoryModel } from "@/components/profile/use-soul-memory-model";

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

function buildSoulModel(markdown: string): SoulMemoryModel {
  return {
    active: true,
    verified: true,
    current: {
      document: { markdown, persisted: true },
      draft: markdown,
    },
    editing: false,
    loading: false,
    failed: false,
    saving: false,
    conflict: false,
    sync: "synced",
    beginEdit: vi.fn(),
    cancelEdit: vi.fn(),
    changeDraft: vi.fn(),
    reloadLatest: vi.fn(),
    retryLoad: vi.fn(),
    retrySync: vi.fn(),
    save: vi.fn(),
  } as unknown as SoulMemoryModel;
}

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

  it("renders compact Personal wiki and Core documents (memory.md, identity.md, soul.md) without inline Markdown sprawl or obsolete Live memory subtitle", async () => {
    const soul = buildSoulModel(
      "# memory.md\n\n## Facts\n- Legal name: Kushal Trivedi\n\n## Projects\n- Hussh One private agent bullet that must not dump inline\n",
    );
    render(
      <MemoryKnowledgeHub
        soul={soul}
        liveMirror={{ status: "loading", view: null }}
      />,
    );

    // Live memory has zero "Updates while the app is open and unlocked." subtitle
    expect(
      screen.queryByText("Updates while the app is open and unlocked."),
    ).toBeNull();

    // Inline classic memory.md bullet is NOT sprawled across the home screen
    expect(
      screen.queryByText(/Hussh One private agent bullet that must not dump inline/),
    ).toBeNull();

    // Personal wiki & Core documents summaries are visible
    await waitFor(() =>
      expect(screen.getByTestId("memory-open-personal-wiki")).toHaveTextContent(
        "2 pages · Conversation memory on",
      ),
    );
    expect(screen.getByTestId("memory-open-index-doc")).toHaveTextContent(
      "Compact wiki index · Primary recall active",
    );
    expect(screen.getByTestId("memory-open-identity-doc")).toHaveTextContent(
      "Kushal Trivedi · Stated identity",
    );
    expect(screen.getByTestId("memory-open-soul-doc")).toHaveTextContent(
      "Kushal · Direct · Short · No em dashes",
    );

    // Opening Personal wiki mounts PersonalWikiPanel inside a dialog
    fireEvent.click(screen.getByRole("button", { name: "Open Personal wiki" }));
    expect(await screen.findByTestId("mock-personal-wiki-panel")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });

    // Opening soul.md mounts the standing writing style editor
    fireEvent.click(screen.getByRole("button", { name: "Open soul.md" }));
    expect(await screen.findByTestId("mock-writing-style-editor")).toBeVisible();
  });
});
