import * as React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIntersectionObserver } from "@/hooks/use-intersection-observer";

const observeMock = vi.fn();
const disconnectMock = vi.fn();

class MockIntersectionObserver {
  observe = observeMock;
  disconnect = disconnectMock;
}

function Harness({ disabled }: { disabled: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useIntersectionObserver(ref, { disabled });

  return <div ref={ref} />;
}

describe("useIntersectionObserver", () => {
  afterEach(() => {
    observeMock.mockClear();
    disconnectMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("does not observe the ref when disabled", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    render(<Harness disabled />);

    expect(observeMock).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
