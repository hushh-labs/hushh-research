import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMirrorFact } from "@/lib/pkm/live-mirror-contract";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), replace: vi.fn(), peek: vi.fn(), loadContext: vi.fn(), clearContext: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() }, revision: 0,
  back: null as null | (() => boolean),
  mirror: { status: "loading", view: null } as LiveMirrorViewState,
}));
vi.mock("@/lib/pkm/use-live-mirror-view", () => ({ useLiveMirrorView: () => mocks.mirror }));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: mocks.load, replaceMarkdownMemoryDocument: mocks.replace, peekMarkdownMemory: mocks.peek,
  MARKDOWN_MEMORY_DOMAIN: "one_memory", MAX_MARKDOWN_MEMORY_CHARS: 18000,
  subscribeMarkdownMemory: () => () => {}, retryMarkdownMemorySync: vi.fn(),
}));
vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  loadAgentPkmContext: mocks.loadContext, clearAgentPkmContext: mocks.clearContext,
}));
vi.mock("@/lib/pkm/use-pkm-domain-change-revision", () => ({ usePkmDomainChangeRevision: () => mocks.revision }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: (_route: string, depth: number, callback: () => boolean) => { mocks.back = depth ? callback : null; } }));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: mocks.toast,
  Button: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button>,
}));

import { SoulMemoryPanel } from "@/components/profile/soul-memory-panel";

const props = { userId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", tokenExpiresAt: Date.now() + 60000, active: true, verified: true };
const markdown = "# Memory\n\n## Preferences\n- Concise answers.\n";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revision = 0;
  mocks.mirror = { status: "loading", view: null };
  mocks.load.mockResolvedValue({ markdown, persisted: true });
  mocks.replace.mockResolvedValue({ success: true, markdown: "# Updated\n" });
});

describe("memory.md editor", () => {
  it("renders the canonical Markdown and saves the edited document for subsequent chat context", async () => {
    render(<SoulMemoryPanel {...props} />);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "memory.md Markdown" }), { target: { value: "# Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-a", expectedMarkdown: markdown, expectedPersisted: true, markdown: "# Updated",
    })));
    await waitFor(() => expect(mocks.clearContext).toHaveBeenCalledWith("owner-a", { preserveMarkdown: true }));
    expect(mocks.toast.success).toHaveBeenCalledWith("memory.md saved");
  });

  it("preserves a dirty draft across automatic memory updates and conflict failures", async () => {
    const view = render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit memory.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "memory.md Markdown" }), { target: { value: "My unsaved edit" } });
    mocks.revision += 1;
    view.rerender(<SoulMemoryPanel {...props} />);
    expect(screen.getByRole("textbox", { name: "memory.md Markdown" })).toHaveValue("My unsaved edit");
    mocks.replace.mockResolvedValueOnce({ success: false, conflict: true, message: "Memory changed" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Reload latest version" });
    expect(screen.getByRole("textbox", { name: "memory.md Markdown" })).toHaveValue("My unsaved edit");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("shows the shared Live memory preview above memory.md, never while editing or before verification", async () => {
    const at = "2026-10-15T10:00:00.000Z";
    mocks.mirror = { status: "ready", view: {
      schemaVersion: "live_mirror.v1", ownerId: "owner-a", vaultEpoch: 0, builtAt: at, inventoryObservedAt: at,
      inventoryComplete: true, issues: [], nameConflict: false, sources: [], markdown: "", evaluatedAt: at,
      overall: "current", lastVerifiedAt: at,
      history: { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" },
      facts: [{ key: "name", predicate: "profile.name", kind: "profile", sourceId: "owner-a", ref: "Profile", field: "name",
        label: "Name", value: "SYNTHETIC_OWNER", state: "verified", revision: 1, sourceUpdatedAt: at, capturedAt: at, verifiedAt: at }],
    } };
    const view = render(<SoulMemoryPanel {...props} />);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    const preview = screen.getByRole("region", { name: "Live memory preview" });
    const soul = screen.getByRole("region", { name: "memory.md" });
    expect(preview.compareDocumentPosition(soul) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(preview).getByText("SYNTHETIC_OWNER")).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/one/profile/my-data");
    expect(within(preview).queryByRole("link", { name: "Open Memory" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory.md" }));
    expect(screen.queryByRole("region", { name: "Live memory preview" })).toBeNull();
    view.unmount();
    // Negative control: an unverified session shows neither memory.md nor the mirror.
    render(<SoulMemoryPanel {...props} verified={false} />);
    expect(screen.queryByRole("region", { name: "Live memory preview" })).toBeNull();
    expect(screen.queryByText("SYNTHETIC_OWNER")).toBeNull();
  });

  it("shows both claims of a disagreement once, above the facts, with no fix link until a source has a route", async () => {
    const at = "2026-10-15T10:00:00.000Z";
    const fact = (field: "name" | "email", label: string, value: string): LiveMirrorFact => ({
      key: `profile.${field}`, predicate: `profile.${field}`, kind: "profile", sourceId: "owner-a", ref: "Profile", field, label, value,
      state: "verified", revision: 1, sourceUpdatedAt: at, capturedAt: at, verifiedAt: at,
    });
    mocks.mirror = { status: "ready", view: {
      schemaVersion: "live_mirror.v1", ownerId: "owner-a", vaultEpoch: 0, builtAt: at, inventoryObservedAt: at,
      inventoryComplete: true, issues: [], nameConflict: true, sources: [], markdown: "", evaluatedAt: at,
      overall: "conflict", lastVerifiedAt: at,
      history: { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" },
      facts: [fact("name", "Name", "SYNTHETIC_OWNER"), fact("email", "Email", "owner@example.test")],
      conflicts: [{ predicate: "profile.name", label: "Name", claims: [
        { source: "soul", label: "Memory", value: "SYNTHETIC_SOUL", revision: 2, sourceUpdatedAt: at, verifiedAt: null },
        { source: "profile", label: "Profile", value: "SYNTHETIC_OWNER", revision: 1, sourceUpdatedAt: at, verifiedAt: at },
      ] }],
    } };
    render(<SoulMemoryPanel {...props} />);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    const preview = within(screen.getByRole("region", { name: "Live memory preview" }));
    expect(preview.getByRole("status")).toHaveTextContent("Needs your review");
    const conflict = preview.getByTestId("live-mirror-conflict");
    expect(within(conflict).getByText("Name")).toBeInTheDocument();
    expect(within(conflict).getByText("Memory: SYNTHETIC_SOUL · Profile: SYNTHETIC_OWNER")).toBeInTheDocument();
    expect(within(conflict).getByText("Needs review")).toBeInTheDocument();
    expect(preview.getAllByTestId(/^live-mirror-(conflict|fact)$/).map(row => row.dataset.testid))
      .toEqual(["live-mirror-conflict", "live-mirror-fact"]);
    expect(within(preview.getByTestId("live-mirror-fact")).getByText("owner@example.test")).toBeInTheDocument();
    // No source has a reachable authority route yet, so See all stays the preview's only link.
    expect(preview.queryByRole("link", { name: /^Fix at source/ })).toBeNull();
    expect(preview.getAllByRole("link").map(link => link.textContent)).toEqual(["See all"]);
  });

  it("cancels editor mode through the shared Back layer before leaving Memory", async () => {
    render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit memory.md" }));
    expect(mocks.back).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Discard this identity edit" } });
    act(() => { expect(mocks.back!()).toBe(true); });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(mocks.back).toBeNull();
  });

  it("hides prior-owner text and ignores a delayed save after verification or owner changes", async () => {
    let finish!: (result: { success: boolean; markdown: string }) => void;
    mocks.replace.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit memory.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "memory.md Markdown" }), { target: { value: "Private owner A draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<SoulMemoryPanel {...props} verified={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Concise answers.")).toBeNull();
    await act(async () => finish({ success: true, markdown: "Private owner A draft" }));
    expect(mocks.clearContext).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    mocks.load.mockResolvedValueOnce({ markdown: "# Owner B", persisted: true });
    view.rerender(<SoulMemoryPanel {...props} userId="owner-b" vaultKey="key-b" vaultOwnerToken="token-b" />);
    await screen.findByRole("heading", { name: "Owner B" });
    expect(screen.queryByText("Private owner A draft")).toBeNull();
  });

  it("fails closed on an unavailable read and never loads remote Markdown images or raw HTML", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Unavailable"));
    const view = render(<SoulMemoryPanel {...props} />);
    await screen.findByText("memory.md couldn’t be opened.");
    expect(mocks.loadContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Edit memory.md" })).toBeNull();
    mocks.load.mockResolvedValueOnce({ markdown: '# Safe\n![Photo](https://example.test/tracker)\n<script>alert(1)</script>', persisted: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Safe" });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
  });
});


it("adds, edits and clears identity facts for an existing owner without onboarding", async () => {
  mocks.load.mockResolvedValue({ markdown: `${markdown}- Legal name: Old name\n- Sex: female\n`, persisted: true });
  render(<SoulMemoryPanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit memory.md" }));
  fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: "Current name" } });
  fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1998-03-14" } });
  fireEvent.change(screen.getByLabelText("Sex"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
  const draft = mocks.replace.mock.calls[0]![0].markdown;
  expect(draft).toContain("Legal name: Current name");
  expect(draft).toContain("Date of birth: 1998-03-14");
  expect(draft).toContain("Concise answers");
  expect(draft).not.toContain("Old name");
  expect(draft).not.toContain("Sex:");
});
