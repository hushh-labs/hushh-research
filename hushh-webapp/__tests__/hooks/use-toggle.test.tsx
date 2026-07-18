import * as React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useToggle } from "@/hooks/use-toggle";

function Harness({ onValue }: { onValue: (value: boolean) => void }) {
  const { value } = useToggle();

  React.useEffect(() => {
    onValue(value);
  }, [onValue, value]);

  return null;
}

describe("useToggle", () => {
  it("returns false for the initial state", () => {
    const onValue = vi.fn();

    render(<Harness onValue={onValue} />);

    expect(onValue).toHaveBeenLastCalledWith(false);
  });
});
