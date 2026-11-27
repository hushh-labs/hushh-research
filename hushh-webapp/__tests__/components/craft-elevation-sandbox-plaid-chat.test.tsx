import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SILENT_LOCATION_CONTINUATION_PROMPT,
  isSilentConnectorContinuationPrompt,
} from "@/components/agent/connector-read-receipt";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { summarizePlaidVaultProjection } from "@/lib/kai/plaid-vault/projection-summary";

describe("Craft elevation: silent chat continuations, brokerage tables, and Plaid metrics", () => {
  it("suppresses synthetic Location and Plaid continuation prompts without hiding real user turns", () => {
    expect(isSilentConnectorContinuationPrompt(SILENT_LOCATION_CONTINUATION_PROMPT)).toBe(true);
    expect(
      isSilentConnectorContinuationPrompt(
        "I just connected Charles Schwab with Plaid. Summarize my connected accounts, balances, and updated financial scopes.",
      ),
    ).toBe(true);
    expect(
      isSilentConnectorContinuationPrompt(
        "I just refreshed my Plaid bank accounts. Summarize my updated balances and confirm my shared scopes updated.",
      ),
    ).toBe(true);
    expect(isSilentConnectorContinuationPrompt("what is the weather today")).toBe(false);
    expect(isSilentConnectorContinuationPrompt("Ask Kushal for his investment portfolio")).toBe(false);
  });

  it("formats brokerage holdings tables with right-aligned tabular numeric columns", () => {
    const markdown = [
      "Shared Investment Portfolio (**$76,339** across 2 positions):",
      "",
      "| Holding | Shares | Value | Weight |",
      "| --- | --- | --- | --- |",
      "| AAPL | 200 | $46,200 | 60.5% |",
      "| VTI | 110 | $30,139 | 39.5% |",
    ].join("\n");

    const { container } = render(<AgentMarkdown text={markdown} />);
    expect(screen.getByRole("region", { name: "Table" })).toBeInTheDocument();
    const cells = Array.from(container.querySelectorAll("tbody td"));
    expect(cells[0]?.textContent).toBe("AAPL");
    expect(cells[0]?.className).not.toContain("text-right");
    expect(cells[1]?.textContent).toBe("200");
    expect(cells[1]?.className).toContain("text-right");
    expect(cells[2]?.textContent).toBe("$46,200");
    expect(cells[2]?.className).toContain("text-right");
    expect(cells[3]?.textContent).toBe("60.5%");
    expect(cells[3]?.className).toContain("text-right");
  });

  it("projects structured Plaid metrics and Investment Portfolio shareable scope metadata", () => {
    const summary = summarizePlaidVaultProjection({
      derived_v1: {
        schema: "plaid-derived-v1",
        net_worth: { value: 185000 },
        liquid_cash: { value: 42000 },
        investable_assets: { value: 143000 },
      },
      portfolio: {
        total_value: 143000,
        holdings: [{ symbol: "AAPL", market_value: 143000 }],
      },
      accounts: {
        schema: "plaid-accounts-v1",
        total_depository_balance: 42000,
      },
    });

    expect(summary.metrics).toEqual([
      { key: "net_worth", label: "Net worth", formatted: "$185,000" },
      { key: "liquid_cash", label: "Liquid cash", formatted: "$42,000" },
      { key: "investable", label: "Investable", formatted: "$143,000" },
    ]);
    expect(summary.scopes).toEqual([
      {
        key: "accounts",
        label: "Bank Accounts",
        valueLabel: "$42,000",
        machineScope: "attr.financial.accounts.*",
      },
      {
        key: "portfolio",
        label: "Investment Portfolio",
        valueLabel: "$143,000",
        machineScope: "attr.financial.portfolio.*",
      },
    ]);
  });
});
