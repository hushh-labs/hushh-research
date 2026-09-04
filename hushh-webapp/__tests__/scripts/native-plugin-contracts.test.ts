import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("native plugin contract verifier", () => {
  it("validates the checked-in iOS and Android plugin trees", () => {
    const verifierPath = path.join(
      process.cwd(),
      "scripts",
      "native",
      "verify-native-plugin-contracts.mjs",
    );

    expect(() =>
      execFileSync(process.execPath, [verifierPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
