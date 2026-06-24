import { describe, expect, it } from "vitest";

import { resolveTopShellMetrics } from "@/components/app-ui/top-shell-metrics";

describe("resolveTopShellMetrics", () => {
  it("returns root metrics for an empty pathname", () => {
    expect(resolveTopShellMetrics("")).toEqual({
      shellVisible: false,
      hasTabs: false,
      contentOffsetMode: "normal",
    });
  });
});
