import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collapseDriveLifecycleRows } from "@/lib/feed/feed-drive-grouping";
import type { FeedItem } from "@/lib/services/feed-service";

// The server mirrors this fold to decide which rows leave with a removal
// (consent-protocol/hushh_mcp/services/feed_drive_fold.py). Both suites read
// these cases, so the two folds cannot drift apart.
type FoldCase = {
  name: string;
  rows: Array<{
    id: string;
    event_type: string;
    request_id: string;
    status: string;
    current_payment_status?: string;
  }>;
  visible: string[];
};
const SHARED_FOLD_CASES = (
  JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        "../../../../consent-protocol/tests/fixtures/feed_drive_fold_cases.json",
      ),
      "utf8",
    ),
  ) as { cases: FoldCase[] }
).cases;

const REQUEST = "request-1";

function row(
  id: string,
  event_type: string,
  user_facing_status: string,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id,
    source_domain: "connected_systems",
    event_type,
    actor_label: "Roopmann V",
    ...overrides,
    metadata: {
      request_id: REQUEST,
      user_facing_status,
      ...overrides.metadata,
    },
    read: false,
    created_at: "2026-10-08T01:08:00.000Z",
  };
}

describe("Drive lifecycle fold shared with the server", () => {
  it.each(SHARED_FOLD_CASES.map((foldCase) => [foldCase.name, foldCase] as const))(
    "%s",
    (_name, foldCase) => {
      const items = foldCase.rows.map((entry) =>
        row(entry.id, entry.event_type, entry.status, {
          metadata: {
            request_id: entry.request_id,
            ...(entry.current_payment_status
              ? { current_payment_status: entry.current_payment_status }
              : {}),
          },
        }),
      );
      expect(collapseDriveLifecycleRows(items).map((item) => item.id)).toEqual(
        foldCase.visible,
      );
    },
  );
});
