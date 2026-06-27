import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TransactionActivity } from "@/components/kai/cards/transaction-activity";

describe("TransactionActivity", () => {
  it("renders empty transactions fallback", () => {
    const { container } = render(<TransactionActivity transactions={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
