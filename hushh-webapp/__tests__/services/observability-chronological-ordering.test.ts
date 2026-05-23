import { describe, expect, it } from "vitest";

import {
  keepLatestTelemetryStates,
  orderTelemetryChronologically,
} from "@/lib/observability/chronological-ordering";

describe("observability chronological ordering", () => {
  const scrambledTelemetryPackets = [
    { id: "log_3", timestamp: "2026-05-23T10:45:00Z", label: "NEWEST_STATE" },
    { id: "log_3", timestamp: "2026-05-23T10:20:00Z", label: "STALE_STATE" },
    { id: "log_1", timestamp: "2026-05-23T10:15:00Z", label: "OLDEST_STATE" },
    { id: "log_2", timestamp: "2026-05-23T10:30:00Z", label: "MID_STATE" },
  ];

  it("sorts telemetry packets into ascending chronological order", () => {
    const orderedLogs = orderTelemetryChronologically(
      scrambledTelemetryPackets
    );

    expect(orderedLogs.map((log) => log.label)).toEqual([
      "OLDEST_STATE",
      "STALE_STATE",
      "MID_STATE",
      "NEWEST_STATE",
    ]);

    for (let index = 1; index < orderedLogs.length; index += 1) {
      expect(Date.parse(orderedLogs[index - 1].timestamp)).toBeLessThan(
        Date.parse(orderedLogs[index].timestamp)
      );
    }
  });

  it("keeps the latest telemetry state for duplicate record ids", () => {
    const latestLogStates = keepLatestTelemetryStates(
      scrambledTelemetryPackets
    );
    const latestLogThree = latestLogStates.find((log) => log.id === "log_3");

    expect(latestLogThree).toEqual({
      id: "log_3",
      timestamp: "2026-05-23T10:45:00Z",
      label: "NEWEST_STATE",
    });
  });

  it("returns an empty sequence for missing telemetry batches", () => {
    expect(orderTelemetryChronologically(null)).toEqual([]);
    expect(keepLatestTelemetryStates(undefined)).toEqual([]);
  });
});
