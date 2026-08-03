import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Kai preferences wizard bounded-flow layout", () => {
  it("keeps a route-owned terminal action inside the viewport that clears onboarding chrome", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/kai/onboarding/KaiPreferencesWizard.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("terminalFooter?: ReactNode");
    expect(source).toContain(
      "min-h-[calc(100dvh-var(--app-scroll-bottom-pad,0px))]",
    );
    expect(source).toContain("pb-[var(--app-scroll-bottom-pad)]");
    expect(source).toContain(
      '<div className="w-full shrink-0">{props.terminalFooter}</div>',
    );
  });
});
