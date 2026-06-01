import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { useDebouncedValue } from "@/hooks/use-debounced-value";

/**
 * Hermetic tests for the `useDebouncedValue` hook.
 *
 * All tests run with fake timers so debounce semantics are deterministic
 * regardless of CI machine speed.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function Harness<T>({
  value,
  delayMs,
  onDebounced,
}: {
  value: T;
  delayMs: number;
  onDebounced: (value: T) => void;
}) {
  const debounced = useDebouncedValue(value, delayMs);
  React.useEffect(() => {
    onDebounced(debounced);
  }, [debounced, onDebounced]);
  return <div data-testid="value">{JSON.stringify(debounced)}</div>;
}

// React is needed for the Harness above; import after the test setup so
// any timer mocks are in place before the React runtime is touched.
import * as React from "react";

describe("useDebouncedValue", () => {
  it("returns the initial value synchronously on the first render", () => {
    const onDebounced = vi.fn();
    render(<Harness value="hello" delayMs={300} onDebounced={onDebounced} />);
    expect(onDebounced).toHaveBeenCalledWith("hello");
  });

  it("does not update the debounced value until the delay has elapsed", () => {
    const onDebounced = vi.fn();
    const { rerender } = render(
      <Harness value="a" delayMs={300} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    rerender(<Harness value="b" delayMs={300} onDebounced={onDebounced} />);

    // Still within the debounce window — no update yet.
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onDebounced).not.toHaveBeenCalled();

    // Crossing the threshold emits exactly one update with the latest value.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDebounced).toHaveBeenCalledTimes(1);
    expect(onDebounced).toHaveBeenLastCalledWith("b");
  });

  it("resets the timer when the value changes again before it elapses", () => {
    const onDebounced = vi.fn();
    const { rerender } = render(
      <Harness value="a" delayMs={300} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    rerender(<Harness value="b" delayMs={300} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    rerender(<Harness value="c" delayMs={300} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // 400ms have passed in total, but the timer reset at the "c" change,
    // so we should still be waiting on the new 300ms window.
    expect(onDebounced).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Now 300ms after the LAST change — emits "c", skipping "b" entirely.
    expect(onDebounced).toHaveBeenCalledTimes(1);
    expect(onDebounced).toHaveBeenLastCalledWith("c");
  });

  it("updates effectively immediately when delayMs is 0", () => {
    const onDebounced = vi.fn();
    const { rerender } = render(
      <Harness value="a" delayMs={0} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    rerender(<Harness value="b" delayMs={0} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(onDebounced).toHaveBeenLastCalledWith("b");
  });

  it("clamps negative or non-finite delays to 0", () => {
    const onDebounced = vi.fn();
    const { rerender } = render(
      <Harness value="a" delayMs={-100} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    rerender(<Harness value="b" delayMs={-100} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onDebounced).toHaveBeenLastCalledWith("b");

    rerender(<Harness value="c" delayMs={Number.NaN} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onDebounced).toHaveBeenLastCalledWith("c");
  });

  it("cancels the pending timeout when the component unmounts", () => {
    const onDebounced = vi.fn();
    const { rerender, unmount } = render(
      <Harness value="a" delayMs={300} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    rerender(<Harness value="b" delayMs={300} onDebounced={onDebounced} />);
    unmount();

    // After unmount, advancing past the delay must not trigger any
    // additional debounced update — the timer was cleared.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onDebounced).not.toHaveBeenCalled();
  });

  it("debounces successive value churn into a single trailing commit", () => {
    const onDebounced = vi.fn();
    const { rerender } = render(
      <Harness value={0} delayMs={150} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    // Simulate rapid keystrokes / state churn.
    for (let next = 1; next <= 10; next++) {
      rerender(<Harness value={next} delayMs={150} onDebounced={onDebounced} />);
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }

    // Mid-stream no commit has fired yet — the timer keeps resetting.
    expect(onDebounced).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    // One trailing commit with the latest value only.
    expect(onDebounced).toHaveBeenCalledTimes(1);
    expect(onDebounced).toHaveBeenLastCalledWith(10);
  });

  it("works for non-primitive values, comparing by reference", () => {
    const onDebounced = vi.fn();
    const initial = { count: 0 };
    const { rerender } = render(
      <Harness value={initial} delayMs={200} onDebounced={onDebounced} />
    );
    onDebounced.mockClear();

    const next = { count: 1 };
    rerender(<Harness value={next} delayMs={200} onDebounced={onDebounced} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(onDebounced).toHaveBeenLastCalledWith(next);
  });
});