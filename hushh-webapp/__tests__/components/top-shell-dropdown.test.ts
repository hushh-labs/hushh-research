import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("top shell dropdown triggers", () => {
  it("preserves accessible labels for menu triggers", () => {
    const topAppBar = read("components/app-ui/top-app-bar.tsx");
    const consentInbox = read("components/consent/consent-inbox-dropdown.tsx");
    const debateTaskCenter = read("components/app-ui/debate-task-center.tsx");

    expect(topAppBar).toContain('aria-label="Open consent inbox"');
    expect(topAppBar).toContain('aria-label="Notifications"');
    expect(consentInbox).toContain('aria-label="Open consent inbox"');
    expect(debateTaskCenter).toContain('aria-label="Notifications"');
  });
});
