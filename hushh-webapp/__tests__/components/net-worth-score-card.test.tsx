import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { NetWorthScoreCard } from "@/components/profile/net-worth-score-card";
import { computePlaidNwsV1, type NwsAccount } from "@/lib/kai/plaid-vault/nws-score";

it("opens the unlinked score detail without starting a bank connection", () => {
  const connect = vi.fn();
  function UnlinkedProfile() {
    const [detail, setDetail] = useState(false);
    return <NetWorthScoreCard report={null} status={null} detail={detail}
      onOpen={() => setDetail(true)} primary={{ label: "Connect bank", run: connect }} />;
  }
  render(<UnlinkedProfile />);
  expect(screen.getByText("—")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Net Worth Score" }));
  expect(screen.queryByRole("button", { name: "Net Worth Score" })).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect bank" }));
  expect(connect).toHaveBeenCalledOnce();
});

it.each([false, true])("shows only the calculated net worth amount (detail=%s)", detail => {
  const cash: NwsAccount = {
    key: "checking", type: "depository", liquidCash: true, currency: "USD",
    current: 100, available: null, limit: null, holdings: null, apr: null,
  };
  const mortgage: NwsAccount = { ...cash, key: "mortgage", type: "loan", current: 2_470_235.75 };
  const report = computePlaidNwsV1({
    accounts: [cash, mortgage], transactions: [], historyComplete: false, asOfTimestamp: "2026-11-06T12:00:00Z",
  });
  const { rerender } = render(<NetWorthScoreCard report={report} status={null} detail={detail} />);
  expect(screen.getByText("-$2,470,135.75")).toBeInTheDocument();
  expect(screen.queryByText(String(report.score))).not.toBeInTheDocument();
  expect(screen.queryByText(/Linked net worth|1,000|Solvency/)).not.toBeInTheDocument();

  rerender(<NetWorthScoreCard report={{ ...report, netWorth: 0 }} status={null} detail={detail} />);
  expect(screen.getByText("$0.00")).toBeInTheDocument();
});
