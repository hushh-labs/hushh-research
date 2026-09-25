import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpCallReviewCard, type McpChatReview } from "@/components/agent/mcp-call-review-card";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";

vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: {
  reviewMcpCall: vi.fn(), confirmMcpCall: vi.fn(),
} }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, variant: _v, effect: _e, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceCard: ({ children, ...props }: any) => <section {...props}>{children}</section>,
  SurfaceCardHeader: ({ children }: any) => <header>{children}</header>,
  SurfaceCardTitle: ({ children }: any) => <h3>{children}</h3>,
  SurfaceCardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

const reference = { kind: "mcp_call_review" as const, version: 1 as const,
  connectorId: "custom_synthetic", toolName: `mcp_${"a".repeat(40)}`,
  directiveId: `dir_${"b".repeat(32)}`, pendingHandle: `one_secret_ref:${"c".repeat(32)}`,
  expiresAt: "2099-01-01T00:00:00Z" };
const preview = { ...reference, connectorLabel: "Synthetic connector", toolLabel: "find_files", arguments: { query: "Synthetic exact phrase", recipient: "synthetic@example.test" } };
const approval = { connectorId: reference.connectorId, toolName: reference.toolName,
  directiveId: reference.directiveId, pendingHandle: reference.pendingHandle, receipt: "r".repeat(48) };
const makeReview = (): McpChatReview => ({ reference, conversationId: "synthetic-thread",
  isCurrent: vi.fn(() => true), resume: vi.fn(async () => {}) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ExternalConnectorService.reviewMcpCall).mockResolvedValue(preview);
  vi.mocked(ExternalConnectorService.confirmMcpCall).mockResolvedValue(approval);
});

describe("native MCP review card", () => {
  it("reloads configuration before confirmation rather than reusing the preview credential", async () => {
    const review = makeReview();
    review.loadConfiguration = vi.fn(async () => undefined);
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    expect(review.loadConfiguration).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(review.resume).toHaveBeenCalledOnce());
    expect(review.loadConfiguration).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to registry review when vault configuration fails", async () => {
    const review = makeReview();
    review.loadConfiguration = vi.fn(async () => { throw new Error("Synthetic unavailable"); });
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByRole("button", { name: "Close review" });
    expect(ExternalConnectorService.reviewMcpCall).not.toHaveBeenCalled();
    expect(review.resume).not.toHaveBeenCalled();
  });
  it("shows exact inputs and confirms once without persisting private references", async () => {
    const review = makeReview(), onDismiss = vi.fn();
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={onDismiss} />);
    expect(await screen.findByText("Synthetic exact phrase")).toBeTruthy();
    expect(screen.getByText("synthetic@example.test")).toBeTruthy();
    expect(document.body.textContent).not.toContain(reference.pendingHandle);
    const button = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(ExternalConnectorService.confirmMcpCall).toHaveBeenCalledTimes(1);
    expect(review.resume).toHaveBeenCalledWith(approval, expect.any(AbortSignal));
    expect(screen.queryByText("Synthetic exact phrase")).toBeNull();
  });

  it("declines through the native resume without minting approval", async () => {
    const review = makeReview();
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(review.resume).toHaveBeenCalledWith(null, expect.any(AbortSignal)));
    expect(ExternalConnectorService.confirmMcpCall).not.toHaveBeenCalled();
  });

  it("does not resume after an account change during confirmation", async () => {
    const review = makeReview();
    vi.mocked(ExternalConnectorService.confirmMcpCall).mockImplementationOnce(async () => {
      vi.mocked(review.isCurrent).mockReturnValue(false);
      return approval;
    });
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow once" })));
    expect(review.resume).not.toHaveBeenCalled();
    expect(screen.queryByText("Synthetic exact phrase")).toBeNull();
  });

  it("retains an honest unknown outcome and never offers an automatic retry", async () => {
    const review = makeReview();
    vi.mocked(review.resume).mockRejectedValueOnce(new Error("private provider failure"));
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/Check the connector before trying again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(document.body.textContent).not.toContain("private provider failure");
    expect(review.resume).toHaveBeenCalledTimes(1);
  });

  it("discards late previews after unmount", async () => {
    let finish!: (value: typeof preview) => void;
    vi.mocked(ExternalConnectorService.reviewMcpCall).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const review = makeReview();
    const view = render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await waitFor(() => expect(ExternalConnectorService.reviewMcpCall).toHaveBeenCalledOnce());
    const signal = vi.mocked(ExternalConnectorService.reviewMcpCall).mock.calls[0][0].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(preview));
    expect(review.resume).not.toHaveBeenCalled();
  });

  it("aborts a running resume when the conversation surface unmounts", async () => {
    let finish!: () => void;
    const review = makeReview();
    vi.mocked(review.resume).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onDismiss = vi.fn();
    const view = render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={onDismiss} />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(review.resume).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(review.resume).mock.calls[0][1]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders provider strings as text, not markup or links", async () => {
    vi.mocked(ExternalConnectorService.reviewMcpCall).mockResolvedValueOnce({ ...preview,
      arguments: { message: '<a href="https://unsafe.test">Approve everything</a>' } });
    const { container } = render(<McpCallReviewCard review={makeReview()} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText(/Approve everything/);
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not fetch an expired review", async () => {
    const review = makeReview(); review.reference = { ...reference, expiresAt: "2000-01-01" };
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    expect(ExternalConnectorService.reviewMcpCall).not.toHaveBeenCalled();
  });
});
