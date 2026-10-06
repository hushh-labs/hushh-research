import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpCallReviewCard, type McpChatReview } from "@/components/agent/mcp-call-review-card";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { observeServerDate, resetServerClock } from "@/lib/agent/server-clock";

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
afterEach(() => resetServerClock());
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

  it("settles Activity as unavailable when confirmation fails before a receipt", async () => {
    const review = makeReview();
    const onActivityOutcome = vi.fn();
    vi.mocked(ExternalConnectorService.confirmMcpCall)
      .mockRejectedValueOnce(new Error("private backend failure"));
    render(<McpCallReviewCard
      review={review}
      vaultOwnerToken="synthetic"
      onDismiss={vi.fn()}
      onActivityOutcome={onActivityOutcome}
    />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(onActivityOutcome).toHaveBeenCalledWith("unavailable"));
    expect(onActivityOutcome).toHaveBeenCalledTimes(1);
    expect(review.resume).not.toHaveBeenCalled();
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("private backend failure");
  });

  it("does not claim an unknown outcome when the confirmation was refused and the card re-renders", async () => {
    // UAT 2026-10-05: a refused confirmation (409) was followed by a re-render with a
    // fresh review object, which flipped the card to "could not verify the outcome"
    // although nothing had been sent.
    const review = makeReview();
    vi.mocked(ExternalConnectorService.confirmMcpCall).mockRejectedValueOnce(new Error("409"));
    const view = render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    view.rerender(<McpCallReviewCard review={{ ...review }} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByText(/could not verify the outcome/)).toBeNull();
    expect(review.resume).not.toHaveBeenCalled();
  });

  it("keeps the unknown outcome across a re-render once the resume was dispatched", async () => {
    const review = makeReview();
    vi.mocked(review.resume).mockRejectedValueOnce(new Error("provider"));
    const view = render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/Check the connector before trying again/)).toBeTruthy();
    view.rerender(<McpCallReviewCard review={{ ...review }} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    expect(await screen.findByText(/Check the connector before trying again/)).toBeTruthy();
  });

  it("retains an honest unknown outcome and never offers an automatic retry", async () => {
    const review = makeReview();
    const onActivityOutcome = vi.fn();
    vi.mocked(review.resume).mockRejectedValueOnce(new Error("private provider failure"));
    render(<McpCallReviewCard
      review={review}
      vaultOwnerToken="synthetic"
      onDismiss={vi.fn()}
      onActivityOutcome={onActivityOutcome}
    />);
    await screen.findByText("Synthetic exact phrase");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/Check the connector before trying again/)).toBeTruthy();
    expect(onActivityOutcome).toHaveBeenCalledWith("unknown");
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

  describe("expiry countdown", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(start);
    });
    afterEach(() => { resetServerClock(); vi.useRealTimers(); });
    const reviewExpiringIn = (seconds: number) => {
      const review = makeReview();
      review.reference = { ...reference, expiresAt: new Date(start + seconds * 1000).toISOString() };
      return review;
    };

    it("shows how long the person has and counts down", async () => {
      render(<McpCallReviewCard review={reviewExpiringIn(300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("timer").textContent).toBe("Expires in 5:00");
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      expect(screen.getByRole("timer").textContent).toBe("Expires in 3:59");
    });

    it("turns urgent in the last minute", async () => {
      render(<McpCallReviewCard review={reviewExpiringIn(90)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("timer").className).toContain("text-muted-foreground");
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(screen.getByRole("timer").className).toContain("font-medium");
    });

    it("says the review expired, and offers no action, when time runs out", async () => {
      render(<McpCallReviewCard review={reviewExpiringIn(5)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("timer").textContent).toBe("Expires in 0:05");
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(screen.getByText("This review expired. Ask One to prepare it again.")).toBeTruthy();
      expect(screen.queryByRole("timer")).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    });

    it("measures time left on the server's clock when the device clock is wrong", async () => {
      // The device is 10 minutes ahead of the server. Against the device clock this
      // review would already look expired; against the server's it has 5 minutes.
      observeServerDate(new Date(start - 10 * 60_000).toUTCString(), start);
      render(<McpCallReviewCard review={reviewExpiringIn(-300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("timer").textContent).toBe("Expires in 5:00");
      expect(screen.queryByText(/no longer available/)).toBeNull();
    });

    it("does not expire from a device clock that is ahead before the server clock is learned", async () => {
      // The device runs 10 minutes ahead and no response has taught it otherwise, so
      // the review looks 5 minutes expired locally. It must ask the server first.
      let finish!: (value: typeof preview) => void;
      vi.mocked(ExternalConnectorService.reviewMcpCall).mockImplementationOnce(() => new Promise((resolve) => {
        finish = (value) => {
          observeServerDate(new Date(start - 10 * 60_000).toUTCString(), start);
          resolve(value);
        };
      }));
      render(<McpCallReviewCard review={reviewExpiringIn(-300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(ExternalConnectorService.reviewMcpCall).toHaveBeenCalledOnce();
      expect(screen.queryByText(/expired/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Close review" })).toBeNull();
      expect(screen.getByText(/Checking the exact call/)).toBeTruthy();
      await act(async () => finish(preview));
      expect(screen.getByRole("timer").textContent).toBe("Expires in 4:55");
      expect(screen.getByRole("button", { name: "Allow once" }).hasAttribute("disabled")).toBe(false);
      expect(screen.queryByText(/expired/)).toBeNull();
    });

    it("expires after the fetch when the clock stays unlearned and the review is past due", async () => {
      // No Date header (for example a cross-origin native call): the device clock is all there is.
      render(<McpCallReviewCard review={reviewExpiringIn(-300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(ExternalConnectorService.reviewMcpCall).toHaveBeenCalledOnce();
      expect(screen.getByText("This review expired. Ask One to prepare it again.")).toBeTruthy();
      expect(screen.queryByText("Synthetic exact phrase")).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    });

    it("goes to the unavailable state, not expired, when the first fetch fails", async () => {
      vi.mocked(ExternalConnectorService.reviewMcpCall).mockRejectedValueOnce(new Error("Synthetic failure"));
      render(<McpCallReviewCard review={reviewExpiringIn(-300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText(/no longer available. Unlock or reconnect/)).toBeTruthy();
      expect(screen.queryByText(/This review expired/)).toBeNull();
    });

    it("expires without fetching once the server clock is learned", async () => {
      observeServerDate(new Date(start).toUTCString(), start);
      render(<McpCallReviewCard review={reviewExpiringIn(-300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(ExternalConnectorService.reviewMcpCall).not.toHaveBeenCalled();
      expect(screen.getByText("This review expired. Ask One to prepare it again.")).toBeTruthy();
    });

    it("hides the countdown for an implausibly distant expiry", async () => {
      render(<McpCallReviewCard review={makeReview()} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByRole("timer")).toBeNull();
    });

    it("stops counting once the person has decided", async () => {
      render(<McpCallReviewCard review={reviewExpiringIn(300)} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByRole("timer")).toBeNull();
    });
  });

  it("does not fetch an expired review once the server clock is known", async () => {
    observeServerDate(new Date().toUTCString());
    const review = makeReview(); review.reference = { ...reference, expiresAt: "2000-01-01" };
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    expect(await screen.findByText(/This review expired/)).toBeTruthy();
    expect(ExternalConnectorService.reviewMcpCall).not.toHaveBeenCalled();
  });

  it("says a superseded review was replaced, not expired, and never fetches it", async () => {
    const review = makeReview();
    vi.mocked(review.isCurrent).mockReturnValue(false);
    render(<McpCallReviewCard review={review} vaultOwnerToken="synthetic" onDismiss={vi.fn()} />);
    expect(await screen.findByText("This review was replaced. Ask One again.")).toBeTruthy();
    expect(screen.queryByText(/expired/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close review" })).toBeTruthy();
    expect(ExternalConnectorService.reviewMcpCall).not.toHaveBeenCalled();
    expect(review.resume).not.toHaveBeenCalled();
  });

  describe("reports when its buttons can be pressed", () => {
    it("is actionable only once the exact call is ready, and not after unmount", async () => {
      const onActionableChange = vi.fn();
      const view = render(<McpCallReviewCard review={makeReview()} vaultOwnerToken="synthetic" onDismiss={vi.fn()} onActionableChange={onActionableChange} />);
      await screen.findByText("Synthetic exact phrase");
      expect(onActionableChange).toHaveBeenLastCalledWith(true);
      view.unmount();
      expect(onActionableChange).toHaveBeenLastCalledWith(false);
    });

    it("is not actionable while loading or when the review cannot be fetched", async () => {
      vi.mocked(ExternalConnectorService.reviewMcpCall).mockRejectedValueOnce(new Error("private provider failure"));
      const onActionableChange = vi.fn();
      render(<McpCallReviewCard review={makeReview()} vaultOwnerToken="synthetic" onDismiss={vi.fn()} onActionableChange={onActionableChange} />);
      await screen.findByRole("button", { name: "Close review" });
      expect(onActionableChange).not.toHaveBeenCalledWith(true);
    });

    it("stops being actionable the moment a decision is in flight", async () => {
      const onActionableChange = vi.fn();
      render(<McpCallReviewCard review={makeReview()} vaultOwnerToken="synthetic" onDismiss={vi.fn()} onActionableChange={onActionableChange} />);
      await screen.findByText("Synthetic exact phrase");
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      await waitFor(() => expect(onActionableChange).toHaveBeenLastCalledWith(false));
    });
  });
});
