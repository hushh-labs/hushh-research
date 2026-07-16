import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

function Probe({ active }: { active: boolean }) {
  useSessionChromeSuppression(active);
  return null;
}

describe("useSessionChromeSuppression", () => {
  it("hides shared bottom chrome while any session guard is checking", () => {
    const first = render(<Probe active />);
    const second = render(<Probe active />);

    expect(document.documentElement).toHaveAttribute("data-session-check-active");

    first.unmount();
    expect(document.documentElement).toHaveAttribute("data-session-check-active");

    second.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-session-check-active");
  });

  it("removes suppression when a guard finishes checking", () => {
    const view = render(<Probe active />);
    view.rerender(<Probe active={false} />);

    expect(document.documentElement).not.toHaveAttribute("data-session-check-active");
    view.unmount();
  });
});
