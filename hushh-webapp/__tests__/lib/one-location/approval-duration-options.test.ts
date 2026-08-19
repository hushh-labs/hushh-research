import { describe, expect, it } from "vitest";

import { approvalDurationOptions } from "@/lib/one-location/duration-copy";

const PRESETS = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

describe("approvalDurationOptions", () => {
  it("returns null for an open-ended ask — no timed override offered", () => {
    expect(
      approvalDurationOptions(
        { requestedDurationHours: null, requestedDurationMode: "until_stopped" },
        PRESETS,
      ),
    ).toBeNull();
  });

  it("returns null when the request carries no usable amount", () => {
    expect(
      approvalDurationOptions(
        { requestedDurationHours: null, requestedDurationMode: "timed" },
        PRESETS,
      ),
    ).toBeNull();
    expect(
      approvalDurationOptions(
        { requestedDurationHours: 0, requestedDurationMode: "timed" },
        PRESETS,
      ),
    ).toBeNull();
  });

  it("returns the presets unchanged when the ask already matches one", () => {
    const options = approvalDurationOptions(
      { requestedDurationHours: 1, requestedDurationMode: "timed" },
      PRESETS,
    );
    expect(options).toEqual(PRESETS);
  });

  // The real bug: a 3-hour ask isn't one of the five presets. The picker
  // must not silently snap to "4 hours" (the nearest preset) while the
  // Approve button one line below still says "Approve 3 hours" — the two
  // would disagree about what tapping Approve actually grants.
  it("inserts the exact amount asked for when it isn't already a preset", () => {
    const options = approvalDurationOptions(
      { requestedDurationHours: 3, requestedDurationMode: "timed" },
      PRESETS,
    );
    expect(options).toEqual([
      { value: "0.25", label: "15 min" },
      { value: "0.5", label: "30 min" },
      { value: "1", label: "1 hour" },
      { value: "3", label: "3 hours" },
      { value: "4", label: "4 hours" },
      { value: "24", label: "24 hours" },
    ]);
  });

  it("keeps the inserted amount sorted correctly at either end", () => {
    expect(
      approvalDurationOptions(
        { requestedDurationHours: 0.1, requestedDurationMode: "timed" },
        PRESETS,
      )?.[0],
    ).toEqual({ value: "0.1", label: "6 min" });
    expect(
      approvalDurationOptions(
        { requestedDurationHours: 30, requestedDurationMode: "timed" },
        PRESETS,
      )?.at(-1),
    ).toEqual({ value: "30", label: "30 hours" });
  });
});
