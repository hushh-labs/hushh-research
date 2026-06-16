import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("/register-phone safe-area shell contract", () => {
  it("uses dynamic viewport height and native safe-area padding variables", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );

    expect(source).toContain("--phone-mandate-safe-pt");
    expect(source).toContain("--phone-mandate-safe-pb");
    expect(source).toContain("var(--app-safe-area-top-effective");
    expect(source).toContain("var(--app-safe-area-bottom-effective");
    expect(source).toContain("min-h-[100dvh]");
    expect(source).toContain("pt-[var(--phone-mandate-safe-pt)]");
    expect(source).toContain("pb-[var(--phone-mandate-safe-pb)]");
    expect(source).not.toContain("4vh");
    expect(source).toContain("min-h-[25rem]");
  });
});
