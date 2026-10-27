import fs from "node:fs";
import path from "node:path";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "../../components/app-ui/bottom-chrome-column";

/** Strict source extraction shared by the agent geometry projections. */
const WEBAPP_ROOT = process.cwd();

export function read(relativePath: string): string {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8").replace(/\r\n?/g, "\n");
}

export function fail(what: string, where: string): never {
  throw new Error(
    `agent-surface-source: could not extract ${what} from ${where}. ` +
      `The shipped markup moved; update this extractor rather than the assertion it feeds.`,
  );
}

/** Exactly one match, or a build-time failure naming what went missing. */
export function one(
  source: string,
  pattern: RegExp,
  what: string,
  where: string,
): RegExpMatchArray {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(
      `agent-surface-source: expected exactly one ${what} in ${where}, found ${matches.length}. ` +
        `An ambiguous anchor is how a fixture starts measuring the wrong control.`,
    );
  }
  return matches[0];
}

/** Collapse the JSX's line breaks so an expression reads as one line. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Only identifiers, operators, string literals and dots. A guard that grew a
 * call, a template literal or a member of `window` is not something this
 * fixture should be executing, and refusing it is cheaper than sandboxing it.
 */
const SAFE_EXPRESSION = /^[A-Za-z0-9_$ .!?:&|'"’,-]*$/;

export type ExpressionScope = Record<string, unknown>;

/** Run one of the shipped guards with the fixture's own state bound to it. */
export function evaluateShippedExpression(
  expression: string,
  scope: ExpressionScope,
): unknown {
  if (!SAFE_EXPRESSION.test(expression)) {
    throw new Error(
      `agent-surface-source: refusing to execute "${expression}". ` +
        `The extracted guard is no longer a plain conditional; read it by hand before trusting this fixture.`,
    );
  }
  const names = Object.keys(scope);
  const run = new Function(
    ...names,
    `"use strict"; return (${expression});`,
  ) as (...args: unknown[]) => unknown;
  return run(...names.map((name) => scope[name]));
}

const PANEL_PATH = "components/agent/hermes-chat-panel.tsx";
const PUPPY_PICKER_PATH = "components/agent/puppy-model-picker.tsx";
const PUPPY_RIBBON_PATH = "components/agent/puppy-chat-controls.tsx";
const PUPPY_CONTROLS_PATH = "components/agent/puppy-local-controls.tsx";

export function readPuppySurface() {
  // --- The Puppy surface's own controls -------------------------------------

  const panel = read(PANEL_PATH);
  const puppyPicker = read(PUPPY_PICKER_PATH);
  const puppyRibbon = read(PUPPY_RIBBON_PATH);
  const puppyControls = read(PUPPY_CONTROLS_PATH);

  // Refuse a fixture whose extracted controls are no longer composed by the panel.
  one(panel, /<PuppyLocalControls\b/, "the local controls composition", PANEL_PATH);
  one(panel, /<AgentBarSurface\b/, "the native-aware composer composition", PANEL_PATH);

  const panelHeaderClass = one(
    puppyRibbon,
    /data-puppy-controls\s+className=\{`([^`]+)`\}/,
    "the Puppy panel header row",
    PUPPY_RIBBON_PATH,
  )[1].replace("${BOTTOM_CHROME_COLUMN_CLASSNAME}", BOTTOM_CHROME_COLUMN_CLASSNAME);
  const panelBodyClass = one(puppyRibbon, /<div className="([^"]+)">\{children\}<\/div>/,
    "the Puppy ribbon body", PUPPY_RIBBON_PATH)[1];
  const controlsClass = one(puppyControls, /<PuppyControlRibbon accessory=\{accessory\}>\s*<div className="([^"]+)">/,
    "the Puppy wrapping controls", PUPPY_CONTROLS_PATH)[1];
  const pickerInstanceClass = one(puppyControls, /<PuppyModelPicker\b[^>]+className="([^"]+)"/,
    "the Puppy picker placement", PUPPY_CONTROLS_PATH)[1];
  const pinClasses = one(puppyControls,
    /aria-pressed=\{onDevice\}\s+className=\{cn\(\s*"([^"]+)",\s*onDevice\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/,
    "the Puppy pin sizing and selected state", PUPPY_CONTROLS_PATH);

  const puppyComposerPlaceholder = one(
    panel,
    /placeholder=\{\s*connected\s*\?\s*"([^"]+)"/,
    "the Puppy composer placeholder",
    PANEL_PATH,
  )[1];

  const puppySendLabel = one(
    panel,
    /aria-label="(Send to [^"]+)"/,
    "the Puppy send button",
    PANEL_PATH,
  )[1];

  const puppyPinLabels = one(
    puppyControls,
    /\{onDevice \? "([^"]+)" : "([^"]+)"\}/,
    "the on-device pin labels",
    PUPPY_CONTROLS_PATH,
  );

  const puppyPickerMatch = one(
    puppyPicker,
    /className=\{cn\(\s*"([^"]+)",\s*className,\s*\)\}\s*title="([^"]+)"/,
    "the Puppy model picker trigger",
    PUPPY_PICKER_PATH,
  );

  return {
    panelHeaderClass,
    panelBodyClass,
    controlsClass,
    pickerInstanceClass,
    pinOnClass: `${pinClasses[1]} ${pinClasses[2]}`,
    composerPlaceholder: puppyComposerPlaceholder,
    sendLabel: puppySendLabel,
    pinOnLabel: puppyPinLabels[1],
    pinOffLabel: puppyPinLabels[2],
    pickerClass: puppyPickerMatch[1],
    pickerTitle: puppyPickerMatch[2],
  };
}
