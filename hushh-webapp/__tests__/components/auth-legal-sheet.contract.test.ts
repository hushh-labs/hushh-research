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

  it("opens the desktop document as a modal so it owns the scroll lock", () => {
    // Opened from a modal (the terms re-prompt, the Profile pane), a non-modal
    // Radix dialog sits outside the parent's scroll lock, so wheel scrolling
    // inside the document was swallowed on desktop. The mobile Sheet was fine.
    const source = fs.readFileSync(
      path.join(WEBAPP_ROOT, "components/onboarding/AuthLegalDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("<Dialog open={isOpen} onOpenChange={onOpenChange} modal>");
    expect(source).not.toMatch(/<Dialog[^>]*modal=\{false\}[^>]*>\s*<DialogContent/);
    expect(source).toMatch(/overflow-y-auto/);
  });
});
