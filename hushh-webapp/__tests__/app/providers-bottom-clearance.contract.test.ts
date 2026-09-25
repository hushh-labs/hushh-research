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
    expect(source).toContain(
      "focusedConnectCircleChromeFlow;",
    );
    expect(source).not.toContain(
      "const bottomChromeHidden = hidesPersistentChrome || focusedLocationSmsFlow;",
    );
    expect(source).toContain("const focusedLocationBottomTask =");
    expect(source).toContain("const focusedConnectCircleChromeFlow =");
    expect(source).toContain("isFocusedConnectCircleTask(");
    expect(source).toContain('"--app-scroll-bottom-pad": bottomChromeHidden');
    expect(source).toContain(
      '"--bottom-chrome-stack-height": bottomChromeHidden',
    );
    expect(source).toContain(
      '? "var(--app-bottom-shell-height, calc(var(--onboarding-agent-bar-clearance) + 1.5rem))"',
    );
    expect(source).toContain('? "0px"');
    expect(source).toContain(": isRiaRoute(pathname)");
    expect(source).toContain(
      '"calc(var(--onboarding-agent-bar-clearance) + 1.5rem)"',
    );
    expect(
      source.match(
        /pb-\[var\(--app-scroll-bottom-pad,var\(--onboarding-agent-bar-clearance\)\)\]/g,
      ),
    ).toHaveLength(2);
  });

  it("gives focused Location terminal actions the bottom edge without stale shell clearance", () => {
    expect(source).toContain(
      "const focusedLocationBottomTask = isFocusedLocationBottomTask(",
    );
    expect(source).toContain(
      "hidesPersistentChrome ||\n    focusedLocationBottomTask ||",
    );
    expect(source).toContain(
      '"--bottom-chrome-stack-height": bottomChromeHidden',
    );
    expect(source).toContain(
      '"--bottom-chrome-full-height": bottomChromeHidden',
    );
    expect(source).toContain(
      '"--bottom-chrome-search-height": bottomChromeHidden',
    );
    expect(source).toContain('"--app-scroll-bottom-pad": bottomChromeHidden');
  });

  it("keeps Agent Bar placement outside the scroll-root layout contract", () => {
    expect(source).not.toContain("<AgentBar bottom=");
    expect(source).toContain("<AppBottomShell model={bottomShellModel} />");
    expect(
      source.indexOf("<AppBottomShell model={bottomShellModel} />"),
    ).toBeLessThan(source.indexOf("<Suspense"));
  });

  it("rides the bottom chrome on transform only, never on height", () => {
    // The mask used to recompute its height from the scroll progress on every
    // frame: one layout per frame, and under a backdrop-filter the blur
    // repaints with it. It is the only non-composited motion this stack had.
    const shell = readFileSync(
      join(process.cwd(), "components/app-ui/app-bottom-shell.tsx"),
      "utf8",
    );
    expect(shell).toContain('height: "var(--bottom-chrome-full-height)"');
    expect(shell).not.toContain(
      "calc(var(--bottom-chrome-full-height) - (var(--bottom-chrome-progress",
    );
    const maskStyle = shell.slice(
      shell.indexOf("const maskStyle"),
      shell.indexOf("as CSSProperties", shell.indexOf("const maskStyle")),
    );
    expect(maskStyle).toContain("translate3d(0, calc(var(--bottom-chrome-progress");
    expect(maskStyle).not.toContain("height:\n");
  });

  it("keeps typed search available while focused Location navigation is hidden", () => {
    expect(commandBarSource).not.toContain("focusedLocationSmsFlow");
    expect(commandBarSource).toContain("!chromeState.hideCommandBar");
  });
});
