import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), replace: vi.fn(), peek: vi.fn(), loadContext: vi.fn(), clearContext: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() }, revision: 0,
  back: null as null | (() => boolean),
}));
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
  mocks.load.mockResolvedValue({ markdown, persisted: true });
  mocks.replace.mockResolvedValue({ success: true, markdown: "# Updated\n" });
});

describe("Soul.md editor", () => {
  it("renders the canonical Markdown and saves the edited document for subsequent chat context", async () => {
    render(<SoulMemoryPanel {...props} />);
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Soul.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Soul.md Markdown" }), { target: { value: "# Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner-a", expectedMarkdown: markdown, expectedPersisted: true, markdown: "# Updated",
    })));
    await waitFor(() => expect(mocks.clearContext).toHaveBeenCalledWith("owner-a", { preserveMarkdown: true }));
    expect(mocks.toast.success).toHaveBeenCalledWith("Soul.md saved");
  });

  it("preserves a dirty draft across automatic memory updates and conflict failures", async () => {
    const view = render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Soul.md" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Soul.md Markdown" }), { target: { value: "My unsaved edit" } });
    mocks.revision += 1;
    view.rerender(<SoulMemoryPanel {...props} />);
    expect(screen.getByRole("textbox")).toHaveValue("My unsaved edit");
    mocks.replace.mockResolvedValueOnce({ success: false, conflict: true, message: "Memory changed" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Reload latest version" });
    expect(screen.getByRole("textbox")).toHaveValue("My unsaved edit");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("cancels editor mode through the shared Back layer before leaving Memory", async () => {
    render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Soul.md" }));
    expect(mocks.back).not.toBeNull();
    act(() => { expect(mocks.back!()).toBe(true); });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(mocks.back).toBeNull();
  });

  it("hides prior-owner text and ignores a delayed save after verification or owner changes", async () => {
    let finish!: (result: { success: boolean; markdown: string }) => void;
    mocks.replace.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<SoulMemoryPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Soul.md" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Private owner A draft" } });
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
    await screen.findByText("Soul.md couldn’t be opened.");
    expect(mocks.loadContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Edit Soul.md" })).toBeNull();
    mocks.load.mockResolvedValueOnce({ markdown: '# Safe\n![Photo](https://example.test/tracker)\n<script>alert(1)</script>', persisted: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Safe" });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
  });
});
