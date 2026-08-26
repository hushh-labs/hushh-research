import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Analysis History destructive confirmation layering", () => {
  it("keeps the pending-delete AlertDialog above the mobile history Sheet", () => {
    const source = read("components/kai/views/analysis-history-dashboard.tsx");
    const sheetPrimitive = read("components/ui/sheet.tsx");
    const alertContentTag = source.match(/<AlertDialogContent[^>]*>/)?.[0];

    expect(source).toContain("pendingDelete");
    expect(sheetPrimitive).toContain("z-[712]");
    expect(alertContentTag).toContain('overlayClassName="z-[713]"');
    expect(alertContentTag).toContain('className="z-[714]"');
  });

  it("uses a centered Dialog for desktop history versions instead of an anchored Popover", () => {
    const source = read("components/kai/views/analysis-history-dashboard.tsx");

    expect(source).toContain('from "@/components/ui/dialog"');
    expect(source).toContain(
      '<Dialog open={versionsOpen} onOpenChange={(open) => !open && closeVersions()}>',
    );
    expect(source).toContain(
      '<DialogContent className="w-[min(28rem,calc(100vw-1.5rem))] p-0 sm:max-w-md">',
    );
    expect(source).toContain(
      '<Sheet open={versionsOpen} onOpenChange={(open) => !open && closeVersions()} modal>',
    );
    expect(source).not.toContain('from "@/components/ui/popover"');
    expect(source).not.toContain("versionsAnchor");
    expect(source).not.toContain("PopoverAnchorPosition");
    expect(source).not.toContain("getBoundingClientRect");
  });
});
