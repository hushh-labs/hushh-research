import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("setup completion footer contract", () => {
  it("uses the canonical safe-area and keyboard-resize-aware bottom inset", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("var(--app-bottom-inset)");
    expect(source).toContain('"h-12 text-base"');
    expect(source).toContain("bg-transparent");
    expect(source).not.toContain("SurfaceInset");
  });

  it("supports a deliberately quieter skip state without changing action authority", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("variant?: ColorVariant");
    expect(source).toContain("effect?: ComponentEffect");
    expect(source).toContain('variant = "blue-gradient"');
    expect(source).toContain('effect = "fill"');
    expect(source).toContain('variant === "none" && effect === "fade"');
    expect(source).toContain('const visualVariant = isQuietSetupAction ? "blue" : variant');
    expect(source).toContain("text-accent-strong");
    expect(source).toContain("data-voice-action-id={actionId}");
  });

  it("keeps the action in the responsive route flow instead of pinning a desktop overlay", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/onboarding/setup/setup-completion-footer.tsx",
      ),
      "utf8",
    );

    expect(source).toContain(
      "sticky bottom-[calc(var(--app-bottom-inset)+var(--onboarding-agent-bar-clearance,3.75rem)+0.75rem)]",
    );
    expect(source).toContain(
      "pb-[calc(var(--app-bottom-inset)+var(--onboarding-agent-bar-clearance,3.75rem)+1.5rem)]",
    );
    expect(source).toContain("space-y-2 bg-transparent py-2");
    expect(source).not.toContain('placement?: "sticky" | "fixed"');
    expect(source).not.toContain("max-w-[var(--app-shell-standard)]");
  });
});
