import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "app/one/kyc/page.tsx"),
  "utf8",
);

describe("One KYC observability outcome ordering", () => {
  it("does not replace a confirmed sent reply with an error after writeback", () => {
    expect(source).toContain('recordedSuccessAction = "reply_sent"');
    expect(source).toContain("if (recordedSuccessAction !== failedAction)");
    expect(source).toContain('recordedSuccessAction === "reply_sent"');
  });

  it("keeps post-mutation workflow refresh errors separate from consent outcomes", () => {
    expect(source.match(/let mutationConfirmed = false;/g)).toHaveLength(2);
    expect(source.match(/mutationConfirmed = true;/g)).toHaveLength(4);
    expect(source).toContain("Access was approved, but the latest workflow status could not refresh.");
    expect(source).toContain("Access was denied, but the latest workflow status could not refresh.");
  });

  it("does not report a denial when no consent request exists", () => {
    expect(source).toContain("if (requestIds.length === 0)");
    expect(source).toContain("No access request is ready for this request yet.");
  });
});
