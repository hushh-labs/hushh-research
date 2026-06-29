import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("DebateTaskCenter", () => {
  it("renders the empty notification copy as a status region", () => {
    const source = readFileSync(
      join(process.cwd(), "components/app-ui/debate-task-center.tsx"),
      "utf8",
    );

    expect(source).toContain("notifications.length === 0 && passiveAppTasks.length === 0");
    expect(source).toContain('<div role="status"');
    expect(source).toContain("No notifications yet.");
  });
});
