import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortfolioImportView } from "@/components/kai/views/portfolio-import-view";

vi.mock("@/lib/navigation/use-scroll-reset", () => ({
  scrollAppToTop: vi.fn(),
}));

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

    fireEvent.click(screen.getByRole("button", { name: /bank account \(via plaid\)/i }));
    expect(onConnectPlaid).toHaveBeenCalledWith("sandbox");

    fireEvent.click(screen.getByRole("button", { name: /load sample brokerage/i }));
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
});
