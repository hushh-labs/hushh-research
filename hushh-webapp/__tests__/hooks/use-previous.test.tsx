import * as React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePrevious } from "@/hooks/use-previous";

function Harness({
  value,
  onPrevious,
}: {
  value: string;
  onPrevious: (value: string | undefined) => void;
}) {
  const previous = usePrevious(value);

  React.useEffect(() => {
    onPrevious(previous);
  }, [onPrevious, previous]);

  return null;
}

describe("usePrevious", () => {
  it("returns undefined on the first render", () => {
    const onPrevious = vi.fn();

    render(<Harness value="first" onPrevious={onPrevious} />);

    expect(onPrevious).toHaveBeenLastCalledWith(undefined);
  });
});
