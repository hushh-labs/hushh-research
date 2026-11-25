import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortfolioImportView } from "@/components/kai/views/portfolio-import-view";

vi.mock("@/lib/navigation/use-scroll-reset", () => ({
  scrollAppToTop: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/setup/finance" }));

describe("PortfolioImportView", () => {
  it("keeps source choices in one compact inset list", () => {
    render(
      <PortfolioImportView
        onFileSelect={vi.fn()}
        onSkip={vi.fn()}
        onPreloadSchema={vi.fn()}
        onConnectPlaid={vi.fn()}
      />,
    );

    expect(screen.getByTestId("portfolio-import-source-options")).toBeTruthy();
    expect(screen.getByTestId("portfolio-import-connect-brokerage")).toBeTruthy();
    expect(screen.getByTestId("portfolio-import-upload-statement")).toBeTruthy();
    expect(screen.getByTestId("portfolio-import-load-sample")).toBeTruthy();
    expect(screen.queryByText("Getting started")).toBeNull();
    expect(screen.queryByText("Read-only sync")).toBeNull();
    expect(screen.queryByText("Tap to upload official statement")).toBeNull();
    expect(screen.queryByText("Finish Finance setup")).toBeNull();
  });

  it("keeps each source and deferral action available", () => {
    const onFileSelect = vi.fn();
    const onSkip = vi.fn();
    const onPreloadSchema = vi.fn();
    const onConnectPlaid = vi.fn();
    const { container } = render(
      <PortfolioImportView
        onFileSelect={onFileSelect}
        onSkip={onSkip}
        onPreloadSchema={onPreloadSchema}
        onConnectPlaid={onConnectPlaid}
        plaidLocalDualEnvironmentEnabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /connect a bank or brokerage/i }));
    expect(onConnectPlaid).toHaveBeenCalledWith("sandbox");

    fireEvent.click(screen.getByRole("button", { name: /try a sample portfolio/i }));
    expect(onPreloadSchema).toHaveBeenCalledOnce();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(["symbol,shares\nONE,1"], "statement.csv", { type: "text/csv" })],
      },
    });
    expect(onFileSelect).toHaveBeenCalledWith(expect.any(File));

    fireEvent.click(screen.getByRole("button", { name: /i'll link this later/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("allows another statement only after the pending import finishes", () => {
    const props = { onFileSelect: vi.fn(), onSkip: vi.fn() };
    const { rerender } = render(<PortfolioImportView {...props} isUploading />);

    expect(screen.getByRole("button", { name: /importing statement/i })).toBeDisabled();
    expect(screen.getByLabelText("Choose a PDF or CSV brokerage statement")).toBeDisabled();

    rerender(<PortfolioImportView {...props} />);
    expect(screen.getByRole("button", { name: /upload a statement/i })).toBeEnabled();
    expect(screen.getByLabelText("Choose a PDF or CSV brokerage statement")).toBeEnabled();
  });

  it("leaves setup routes with one route-owned deferral action", () => {
    render(
      <PortfolioImportView
        onFileSelect={vi.fn()}
        onSkip={vi.fn()}
        showSkip={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /i'll link this later/i }),
    ).toBeNull();
  });

  it("starts a setup source as soon as its card is tapped", () => {
    const connect = vi.fn();
    const sample = vi.fn();
    render(<PortfolioImportView presentation="onboarding" onFileSelect={vi.fn()}
      onSkip={vi.fn()} onConnectPlaid={connect} onPreloadSchema={sample} plaidLocalDualEnvironmentEnabled />);
    fireEvent.click(screen.getByRole("button", { name: /Try a sample/ }));
    expect(sample).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Connect your Plaid account/ }));
    expect(connect).toHaveBeenCalledWith("sandbox");
  });

  it("blocks all setup source actions while connecting and rejects unsupported files", () => {
    const connect = vi.fn();
    const skip = vi.fn();
    const file = vi.fn();
    const { rerender } = render(<PortfolioImportView presentation="onboarding" onFileSelect={file}
      onSkip={skip} onConnectPlaid={connect} isConnectingPlaid />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening Plaid…");
    fireEvent.click(screen.getByRole("button", { name: /Connect your Plaid account/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(connect).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
    rerender(<PortfolioImportView presentation="onboarding" onFileSelect={file}
      onSkip={skip} plaidConfigured={false} />);
    expect(screen.getByRole("button", { name: /Upload a statement/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Choose a PDF or CSV brokerage statement"), {
      target: { files: [new File(["bad"], "not-a-statement.txt", { type: "text/plain" })] },
    });
    expect(file).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Choose a PDF or CSV");
  });
});
