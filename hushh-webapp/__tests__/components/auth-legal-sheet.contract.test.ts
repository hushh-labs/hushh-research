import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

describe("Authentication legal sheet", () => {
  it("uses the canonical mobile Sheet primitive", () => {
    const source = fs.readFileSync(
      path.join(WEBAPP_ROOT, "components/onboarding/AuthLegalDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("<Sheet modal");
    expect(source).toContain('side="bottom"');
    expect(source).toContain("<SheetTitle");
    expect(source).toContain("<SheetClose");
    expect(source).not.toContain("<Drawer");
  });
});
