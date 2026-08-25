import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("app shell bottom-clearance contract", () => {
  const source = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");
  const commandBarSource = readFileSync(
    join(process.cwd(), "components/kai/kai-command-bar-global.tsx"),
    "utf8",
  );

  it("reserves the existing Agent Bar footprint for hidden-shell scroll roots", () => {
    expect(source).toContain("const bottomChromeHidden = hidesPersistentChrome;");
    expect(source).not.toContain(
      "const bottomChromeHidden = hidesPersistentChrome || focusedLocationSmsFlow;",
    );
    expect(source).toContain('"--app-scroll-bottom-pad": hidesPersistentChrome');
    expect(source).toContain(
      '"--bottom-chrome-stack-height": effectiveHideCommandBar',
    );
    expect(source).toContain(
      '? "var(--app-bottom-shell-height, calc(var(--onboarding-agent-bar-clearance) + 1.5rem))"',
    );
    expect(source).toContain('? "0px"');
    expect(source).toContain(': isRiaRoute(pathname)');
    expect(source).toContain(
      '"calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"',
    );
    expect(source.match(/pb-\[var\(--app-scroll-bottom-pad,var\(--onboarding-agent-bar-clearance\)\)\]/g)).toHaveLength(2);
  });

  it("keeps Agent Bar placement outside the scroll-root layout contract", () => {
    expect(source).not.toContain("<AgentBar bottom=");
    expect(source).toContain("<AppBottomShell model={bottomShellModel} />");
    expect(source.indexOf("<AppBottomShell model={bottomShellModel} />")).toBeLessThan(
      source.indexOf("<Suspense"),
    );
  });

  it("keeps typed search available while focused Location navigation is hidden", () => {
    expect(commandBarSource).not.toContain("focusedLocationSmsFlow");
    expect(commandBarSource).toContain(
      "if (chromeState.hideCommandBar || agentWindowOpen)",
    );
  });
});
