import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiveMirrorReadTime, buildLiveMirrorProjection } from "@/lib/pkm/live-mirror-projection";
import { formatLiveMirrorDateTime } from "@/lib/pkm/live-mirror-presentation";
import { appendVerifiedLivingSourceChanges, reconcileLivingSources } from "@/lib/pkm/living-source-records";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), replace: vi.fn(), peek: vi.fn(), retrySync: vi.fn(), loadContext: vi.fn(), clearContext: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() }, revision: 0,
  back: null as null | (() => boolean),
  mirror: { status: "loading", view: null } as LiveMirrorViewState,
}));
vi.mock("@/lib/pkm/use-live-mirror-view", () => ({ useLiveMirrorView: () => mocks.mirror }));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: mocks.load, replaceMarkdownMemoryDocument: mocks.replace, peekMarkdownMemory: mocks.peek,
  MARKDOWN_MEMORY_DOMAIN: "one_memory", MAX_MARKDOWN_MEMORY_CHARS: 18000,
  subscribeMarkdownMemory: () => () => {}, retryMarkdownMemorySync: mocks.retrySync,
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
import { useSoulMemoryModel } from "@/components/profile/use-soul-memory-model";

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
    // Nothing disagrees, so there is nothing to fix.
    expect(within(preview).queryByTestId("live-mirror-fix-at-source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory.md" }));
    expect(screen.queryByRole("region", { name: "Live memory preview" })).toBeNull();
    view.unmount();
    // Negative control: an unverified session shows neither memory.md nor the mirror.
    render(<SoulMemoryPanel {...props} verified={false} />);
    expect(screen.queryByRole("region", { name: "Live memory preview" })).toBeNull();
    expect(screen.queryByText("SYNTHETIC_OWNER")).toBeNull();
  });

  it("shows every side of a disagreement once, above the facts, with a fix row to the disputed source", async () => {
    const at = "2026-10-15T10:00:00.000Z";
    const written = "2026-10-15T09:40:00.000Z";
    // Through the real pipeline: memory.md, at revision 2, names the owner
    // differently from the verified profile.
    const inventory = reconcileLivingSources(null, [{ kind: "profile", id: "owner-a", createdAt: null, updatedAt: at,
      value: { name: "SYNTHETIC_OWNER", email: "owner@example.test" } }], ["profile"], [], at);
    const projection = buildLiveMirrorProjection({
      ownerId: "owner-a", vaultEpoch: 0, now: at, inventory, history: appendVerifiedLivingSourceChanges(null, null, inventory),
      document: { markdown: "", complete: true, sourceLinks: [], excludedDomains: [], freshness: [
        { domain: "one_memory", title: "Identity facts", status: "conflicted", contentRevision: 2, updatedAt: written, cardCount: 1 },
      ] },
      nameConflict: true,
      nameClaims: { soul: ["SYNTHETIC_SOUL"], profile: "SYNTHETIC_OWNER" },
    });
    mocks.mirror = { status: "ready", view: applyLiveMirrorReadTime(projection, at, "current") };
    render(<SoulMemoryPanel {...props} />);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    const preview = within(screen.getByRole("region", { name: "Live memory preview" }));
    expect(preview.getByRole("status")).toHaveTextContent("Needs your review");
    const conflict = preview.getByTestId("live-mirror-conflict");
    expect(within(conflict).getByText("Name")).toBeInTheDocument();
    expect(within(conflict).getByText(`Your memory: SYNTHETIC_SOUL · Changed ${formatLiveMirrorDateTime(written)} · Version 2`)).toBeInTheDocument();
    expect(within(conflict).getByText("Profile: SYNTHETIC_OWNER · Checked just now · Version 1")).toBeInTheDocument();
    expect(within(conflict).queryByText("Needs review")).toBeNull();
    expect(preview.getAllByTestId(/^live-mirror-(conflict|fact)$/).map(row => row.dataset.testid))
      .toEqual(["live-mirror-conflict", "live-mirror-fact"]);
    expect(within(preview.getByTestId("live-mirror-fact")).getByText("owner@example.test")).toBeInTheDocument();
    // The disputed name is fixed where it lives: the Profile account screen.
    // This is Memory already, so memory.md gets no row of its own.
    expect(preview.getAllByTestId("live-mirror-fix-at-source")).toHaveLength(1);
    expect(preview.getByRole("link", { name: "Edit profile" })).toHaveAttribute("href", "/one/profile/account");
    expect(preview.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["/one/profile/my-data", "/one/profile/account"]);
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

  it("rejects retained editor ports after owner replacement without erasing the new owner's document", async () => {
    const view = renderHook(options => useSoulMemoryModel(options), { initialProps: props });
    await waitFor(() => expect(view.result.current.current?.document.markdown).toBe(markdown));
    act(() => view.result.current.beginEdit());
    const retired = view.result.current;
    mocks.load.mockResolvedValueOnce({ markdown: "# New owner", persisted: true });
    view.rerender({ ...props, userId: "owner-b", vaultKey: "key-b", vaultOwnerToken: "token-b" });
    await waitFor(() => expect(view.result.current.current?.document.markdown).toBe("# New owner"));
    const reads = mocks.load.mock.calls.length;
    act(() => { retired.beginEdit(); retired.changeDraft("Late old-owner edit"); retired.cancelEdit(); retired.reloadLatest(); retired.retryLoad(); });
    expect(view.result.current.current?.document.markdown).toBe("# New owner");
    expect(view.result.current.editing).toBe(false);
    expect(mocks.load).toHaveBeenCalledTimes(reads);
    await act(async () => { await retired.save(); await retired.retrySync(); });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.retrySync).not.toHaveBeenCalled();
  });

  it("rejects old Save and sync bindings while preserving the draft across token renewal", async () => {
    const view = renderHook(options => useSoulMemoryModel(options), { initialProps: props });
    await waitFor(() => expect(view.result.current.current?.document.markdown).toBe(markdown));
    act(() => view.result.current.beginEdit());
    act(() => view.result.current.changeDraft("First draft"));
    const oldDraft = view.result.current;
    act(() => view.result.current.changeDraft("Latest draft"));
    await act(async () => { await oldDraft.save(); });
    expect(mocks.replace).not.toHaveBeenCalled();
    const oldCredential = view.result.current;
    view.rerender({ ...props, vaultOwnerToken: "renewed-token" });
    expect(view.result.current.current?.draft).toBe("Latest draft");
    await act(async () => { await oldCredential.save(); await oldCredential.retrySync(); });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.retrySync).not.toHaveBeenCalled();
    await act(async () => { await view.result.current.save(); });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ markdown: "Latest draft", vaultOwnerToken: "renewed-token" }));
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
