import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StaleCacheTimestamp } from "@/components/system/stale-cache-timestamp";

describe("StaleCacheTimestamp", () => {
  it("renders stale label", () => {
    render(<StaleCacheTimestamp label="Using cached consent data" stale />);

    expect(screen.getByText(/Using cached consent data.*stale/)).toBeTruthy();
  });
});
