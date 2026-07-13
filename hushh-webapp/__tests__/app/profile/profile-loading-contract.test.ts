import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profileLoadingSource = readFileSync(
  join(process.cwd(), "app/profile/loading.tsx"),
  "utf8",
);

describe("Profile route loading contract", () => {
  it("does not replace a warm Profile transition with the generic skeleton", () => {
    expect(profileLoadingSource).toContain("return null;");
    expect(profileLoadingSource).not.toContain("RouteLoadingState");
  });
});
