import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs
    .readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("ConsentNotificationProvider", () => {
  it("covers push fallback delivery mode", () => {
    const source = read("components/consent/notification-provider.tsx");

    expect(source).toContain('| "push_failed_fallback_active"');
    expect(source).toContain("function deliveryModeFromInitStatus");
    expect(source).toContain('if (status === "push_active") return "push_active";');
    expect(source).toContain('if (status === "push_blocked") return "push_blocked";');
    expect(source).toContain('return "push_failed_fallback_active";');
    expect(source).toContain('setDeliveryMode("push_failed_fallback_active");');
    expect(source).toContain(
      'initStatus === "push_blocked"\n            ? "push_blocked"\n            : "push_failed_fallback_active"',
    );
  });
});
