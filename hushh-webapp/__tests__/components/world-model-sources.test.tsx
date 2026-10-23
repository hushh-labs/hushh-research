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
  it("requires fresh source permission for Find more and never prepares a Gemini source draft", () => {
    mock.read.mockResolvedValue(null);
    const research = vi.fn(), refresh = vi.fn();
    const props = { ownerId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", name: "Alice", discovery: true,
      initialUrls: ["https://github.com/public-example"], onResearchPublicProfiles: research, onRefresh: refresh };
    const view = render(<WorldModelSources {...props} />);
    expect(screen.getByLabelText("Page links, one per line")).toHaveValue(props.initialUrls[0]);
    const submit = screen.getByRole("button", { name: "Find more about me" });
    expect(submit).toBeDisabled();
    expect(research).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(mock.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Read these pages" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    expect(research).toHaveBeenCalledExactlyOnceWith(props.initialUrls);
    expect(mock.prepare).not.toHaveBeenCalled();
    view.rerender(<WorldModelSources {...props} present={false} />);
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use my existing search details" }));
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(<WorldModelSources {...props} vaultOwnerToken="renewed" />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(submit).toBeDisabled();
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