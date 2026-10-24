import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/profile/world-model" }));
vi.mock("@/lib/services/world-model-source-service", () => ({ WorldModelSourceService: mock }));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", () => ({
  createAgentPkmCaptureGuard: ({ signal, isEnabled }: { signal: AbortSignal; isEnabled: () => boolean }) => ({
    isCurrent: () => !signal.aborted && isEnabled(),
    assertCurrent: () => { if (signal.aborted || !isEnabled()) throw new Error("stale"); },
  }),
}));
vi.mock("@/components/agent/profile-research-card", () => ({
  ProfileResearchCard: ({ initialResult }: { initialResult: { draft_id: string } }) => <div>{initialResult.draft_id}</div>,
}));
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { claim } from "../fixtures/world-model-review";
import { WorldModelSources } from "@/components/profile/world-model-sources";
beforeEach(() => vi.clearAllMocks());

  it("requires the public-page permission before Azure research and keeps Gemini review separate", () => {
    mock.read.mockResolvedValue(null);
    const research = vi.fn();
    const props = { ownerId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", name: "Alice", onResearchPublicProfiles: research };
    const view = render(<WorldModelSources {...props} />);
    fireEvent.change(screen.getByLabelText("Page links, one per line"), { target: { value: "https://github.com/public-example" } });
    const button = screen.getByRole("button", { name: "Research these profiles" });
    expect(button).toBeDisabled(); fireEvent.click(button); expect(research).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    expect(research).toHaveBeenCalledWith(["https://github.com/public-example"]);
    expect(mock.prepare).not.toHaveBeenCalled();
    view.rerender(<WorldModelSources {...props} present={false} />);
    expect(screen.getByRole("button", { name: "Research these profiles" })).toBeDisabled();
  });
  it("defaults to saved context, requires permission only for optional links and retires old controls", () => {
    mock.read.mockResolvedValue(null);
    const research = vi.fn(), refresh = vi.fn();
    const props = { ownerId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", name: "Alice", discovery: true,
      initialUrls: ["https://github.com/public-example"], onResearchPublicProfiles: research, onRefresh: refresh };
    const view = render(<WorldModelSources {...props} />);
    expect(screen.queryByLabelText("Page links, one per line")).toBeNull();
    const submit = screen.getByRole("button", { name: "Update my model" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(refresh).toHaveBeenCalledExactlyOnceWith();
    expect(research).not.toHaveBeenCalled();
    expect(mock.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add public links (optional)" }));
    expect(screen.getByLabelText("Page links, one per line")).toHaveValue(props.initialUrls[0]);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(research).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    expect(research).toHaveBeenCalledExactlyOnceWith(props.initialUrls);
    view.rerender(<WorldModelSources {...props} present={false} />);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(research).toHaveBeenCalledTimes(1);
    view.rerender(<WorldModelSources {...props} vaultOwnerToken="renewed" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(submit).toBeEnabled();
    expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("does not let an old initial read replace a newly prepared draft", async () => {
    let finish!: (value: unknown) => void;
    mock.read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mock.prepare.mockResolvedValue({
      status: "offered",
      draft_id: "new-draft",
    });
    render(
      <WorldModelSources
        ownerId="owner-a"
        vaultKey="key-a"
        vaultOwnerToken="token-a"
        name="Alice"
      />,
    );
    fireEvent.change(
      screen.getByLabelText("Page links, one per line"),
      { target: { value: "https://example.test/alice" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Read these pages" }),
    );
    await screen.findByText("new-draft");
    await act(async () => finish({ status: "offered", draft_id: "old-draft" }));
    expect(screen.getByText("new-draft")).toBeInTheDocument();
    expect(screen.queryByText("old-draft")).not.toBeInTheDocument();
  });
  it("prefills account and confirmed details with Edit controls and unwinds optional links first", async () => {
    const saved = await claim("Maintains the public Lumen project");
    const editAccount = vi.fn(), editConfirmed = vi.fn();
    const props = { ownerId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", name: "Alice", discovery: true,
      identity: { name: "Alice", email: "alice@example.test", emailVerified: true, phone: "+14155550123" },
      confirmedDetails: [saved], onEditAccount: editAccount, onEditConfirmed: editConfirmed, onRefresh: vi.fn() };
    render(<WorldModelSources {...props} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(saved.text)).toBeInTheDocument();
    expect(screen.queryByText(props.identity.email)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit account details" }));
    expect(editAccount).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: `Edit: ${saved.text}` }));
    expect(editConfirmed).toHaveBeenCalledWith(saved);
    fireEvent.click(screen.getByRole("button", { name: "Add public links (optional)" }));
    expect(screen.getByLabelText("Page links, one per line")).toBeInTheDocument();
    act(() => { expect(unwindBackLayer("/one/profile/world-model")).toBe(true); });
    expect(screen.queryByLabelText("Page links, one per line")).toBeNull();
    expect(unwindBackLayer("/one/profile/world-model")).toBe(false);
  });
