import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { NetWorthScoreCard } from "@/components/profile/net-worth-score-card";

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
