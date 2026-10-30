import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/**
 * A switch in the Connectors pane must still look like a switch.
 *
 * Founder report: in Profile › Connections › Google Drive, "Background Drive
 * access" and "Prepare packets" both showed their On captions while each
 * switch looked Off — white knob on the left, pale track. The switches were
 * on. The pane's stylesheet turns every <button> in a settings row's trailing
 * slot into an 88px pale pill (the Connect / Manage action), and a Radix
 * switch is a <button role="switch">. A CSS-module rule is unlayered, so it
 * beats Tailwind's layered utilities: the pale fill replaced the green track,
 * and the 20px knob travel stopped well short of the right edge of an 88px
 * track. jsdom cannot compute the cascade, so this test asks the stylesheet
 * which of its rules would restyle each control in the real row markup.
 */

const require = createRequire(import.meta.url);
const postcss = require("postcss");

const STYLESHEET = "components/profile/profile-auxiliary-tabs.module.css";

/** Declarations that change a switch's track fill, its box (and so the knob's travel) or its edge. */
const LOOK =
  /^(background(-color|-image)?|(min-|max-)?(width|height)|padding(-(inline|block|left|right|top|bottom))?(-(start|end))?|border(-(color|width|style))?|transform|translate)$/;

/** `:global(X)` → `X`, so the selector can run against the rendered DOM. */
function withoutGlobal(selector: string): string {
  let out = "";
  for (let i = 0; i < selector.length; ) {
    if (!selector.startsWith(":global(", i)) {
      out += selector[i++];
      continue;
    }
    let depth = 1;
    let end = i + ":global(".length;
    const start = end;
    while (end < selector.length && depth) {
      if (selector[end] === "(") depth++;
      else if (selector[end] === ")") depth--;
      end++;
    }
    out += selector.slice(start, end - 1);
    i = end;
  }
  return out;
}

/** Every rule in the pane stylesheet that would change how `element` looks. */
function rulesRestyling(element: Element): string[] {
  const root = postcss.parse(
    readFileSync(path.join(process.cwd(), STYLESHEET), "utf8"),
  );
  const hits: string[] = [];
  root.walkRules((rule: { selectors: string[]; nodes: Array<{ type: string; prop?: string }> }) => {
    const props = rule.nodes
      .filter((node) => node.type === "decl" && LOOK.test(node.prop ?? ""))
      .map((node) => node.prop);
    if (!props.length) return;
    for (const selector of rule.selectors) {
      let matches = false;
      try {
        matches = element.matches(withoutGlobal(selector));
      } catch {
        // jsdom cannot evaluate every selector (`:is()` around `:not()`
        // chains). Fail closed when one could reach a button.
        matches = /\bbutton\b|\[role=|\*/.test(selector);
      }
      if (matches) {
        hits.push(`${selector.replace(/\s+/g, " ")} { ${props.join(", ")} }`);
      }
    }
  });
  return hits;
}

/** The Drive rows as Profile renders them: pane root › page shell › connectors › connector detail. */
function renderInConnectorsPane() {
  return render(
    <div className="profile-pane-scroll-root">
      <div className="app-page-shell">
        <div className="connectors">
          <div data-connector-detail="google_drive">
            <SettingsGroup density="compact">
              <SettingsRow
                title="Background Drive access"
                description="Agent One works while you’re away."
                trailing={
                  <Switch size="ios" aria-label="Background Drive access" checked onCheckedChange={() => {}} />
                }
              />
              <SettingsRow
                title="Prepare packets"
                description="Agent One won’t prepare new packets."
                trailing={
                  <Switch size="ios" aria-label="Prepare packets" checked={false} onCheckedChange={() => {}} />
                }
              />
              <SettingsRow
                title="Google Drive"
                trailing={
                  <Button variant="ghost" size="compact" onClick={() => {}}>
                    Connect
                  </Button>
                }
              />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </div>,
  );
}

afterEach(cleanup);

describe("Connectors pane switches", () => {
  it("leaves the Drive switches' track, size and knob to the Switch itself, on and off", () => {
    renderInConnectorsPane();
    for (const name of ["Background Drive access", "Prepare packets"]) {
      const control = screen.getByRole("switch", { name });
      expect(control.closest('[data-slot="settings-row-trailing"]')).not.toBeNull();
      expect({ name, rules: rulesRestyling(control) }).toEqual({ name, rules: [] });
    }
  });

  it("still styles an ordinary trailing action as a pill, so the guard is not vacuous", () => {
    renderInConnectorsPane();
    const connect = screen.getByRole("button", { name: "Connect" });
    const pill = rulesRestyling(connect).find((rule) =>
      rule.includes('[data-slot="settings-row-trailing"] button'),
    );
    expect(pill).toMatch(/\bbackground\b/);
    expect(pill).toMatch(/\bwidth\b/);
  });
});
