import fs from "node:fs";
import path from "node:path";

/**
 * The Agent Chat header, read out of the shipped source rather than retyped.
 *
 * `agent-chat-workspace.tsx` is 6,200 lines behind One's sign-in, wired to
 * Firebase auth, the vault, the AG-UI stream and a dozen services. A Playwright
 * spec cannot mount it, and a spec that navigates to `/one` without reviewer
 * credentials proves only that the welcome screen renders.
 *
 * So the header is REBUILT as a standalone fixture, the way
 * `gemini-endpoint-fields.layout.spec.ts` rebuilds the endpoint fields: every
 * value that decides what appears on screen is extracted from the shipped file,
 * not copied into the test. Two kinds of value are lifted here:
 *
 *   1. Class strings and copy, so the fixture lays out and reads like the real
 *      header and a stale copy of either cannot pass.
 *   2. The CONDITIONAL EXPRESSIONS themselves. `gateExpression` is the literal
 *      source text of the guard that decides whether One's cloud model picker
 *      renders, and the fixture EXECUTES it with `isPuppySurface` bound. Delete
 *      the guard, invert it, or reorder the actions around it, and the
 *      fixture's screen changes with the product's.
 *
 * Every extraction is anchored and asserted. A rename this file cannot follow
 * throws here, at build time, instead of quietly rendering an empty header that
 * satisfies every assertion downstream.
 *
 * What this CANNOT do is exercise the real component: state, effects, focus
 * handling and Radix internals are not in the fixture. The spec's own header
 * comment records that boundary and stays inside it.
 */

const WEBAPP_ROOT = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8").replace(/\r\n?/g, "\n");
}

function fail(what: string, where: string): never {
  throw new Error(
    `agent-surface-source: could not extract ${what} from ${where}. ` +
      `The shipped markup moved; update this extractor rather than the assertion it feeds.`,
  );
}

/** Exactly one match, or a build-time failure naming what went missing. */
function one(
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
function flatten(text: string): string {
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

const WORKSPACE_PATH = "components/agent/agent-chat-workspace.tsx";
const PANEL_PATH = "components/agent/hermes-chat-panel.tsx";
const PUPPY_PICKER_PATH = "components/agent/puppy-model-picker.tsx";
const SEGMENTED_PATH = "lib/morphy-ux/ui/segmented-control.tsx";

const workspace = read(WORKSPACE_PATH);

/**
 * The header only. Anchored between its own class name and the comment that
 * introduces the two transcripts, so no regex below can wander into the 5,000
 * lines of composer and transcript underneath and match the wrong control.
 */
const headerStart = workspace.indexOf('"agent-chat-header ');
const headerEnd = workspace.indexOf("<OneAgentProfileSheet", headerStart);
if (headerStart < 0 || headerEnd < headerStart) {
  fail("the header region", WORKSPACE_PATH);
}
const header = workspace.slice(headerStart, headerEnd);

const headerContainerClass = one(
  header,
  /"(agent-chat-header [^"]+)"/,
  "header container class",
  WORKSPACE_PATH,
)[1];
const chromeSource = read("components/app-ui/native-chat-chrome.tsx");
const historySource = chromeSource.slice(chromeSource.indexOf("export function NativeHistoryOpener"), chromeSource.indexOf("export function NativeHistoryClose"));
const historyClass = one(historySource, /className="(relative z-\[540\] flex h-11 w-11[^\"]+)"/,
  "authored History hit region", "components/app-ui/native-chat-chrome.tsx")[1];

/**
 * The header is three flex regions and only the middle one may give way:
 * history (fixed), identity (flex-1, clips), actions (shrink-0). The identity
 * region carries a data attribute so this anchor names the region, not a
 * styling that may change under it.
 */
const identityClass = one(
  header,
  /data-agent-chat-header-region="identity"\s+className="([^"]+)"/,
  "identity region class",
  WORKSPACE_PATH,
)[1];

const brandTileClass = one(
  header,
  /data-agent-chat-brand-tile\s+className="([^"]+)"/,
  "brand tile class",
  WORKSPACE_PATH,
)[1];

const nameMatch = one(
  header,
  /<div data-profile-role=\{!isPuppySurface \? "label" : undefined\} className="(truncate text-base[^"]+)">\s*\{([^}]+)\}/,
  "agent name",
  WORKSPACE_PATH,
);

/**
 * The subtitle is `ChatAgentSubtitle`, defined above the component, so its
 * class is read from the whole file. It also carries One's live status (the
 * running tool, or the stream's status text) in place of a separate status
 * slot. That half is runtime state no fixture can hold, so the fixture renders
 * the idle subtitle: the Puppy literal and One's resting fallback, both read
 * from the shipped ternary.
 */
const subtitleClass = one(
  workspace,
  /function ChatAgentSubtitle[\s\S]*?<p aria-live="polite" className="([^"]+)">/,
  "agent subtitle class",
  WORKSPACE_PATH,
)[1];

// The header renders `chatHeaderSubtitle(...)`; its resting wording lives in
// that function (Puppy's literal) and in IDLE_AGENT_SUBTITLE, both read from
// the shipped source so the fixture cannot drift from what people see.
one(
  header,
  /<ChatAgentSubtitle text=\{chatHeaderSubtitle\(\{/,
  "agent subtitle expression",
  WORKSPACE_PATH,
);
const puppySubtitle = one(
  workspace,
  /export function chatHeaderSubtitle[\s\S]*?if \(input\.isPuppySurface\) return ("[^"]*");/,
  "Puppy subtitle literal",
  WORKSPACE_PATH,
)[1];
const idleSubtitle = one(
  workspace,
  /export const IDLE_AGENT_SUBTITLE = ("[^"]*");/,
  "idle agent subtitle",
  WORKSPACE_PATH,
)[1];
const subtitleExpression = `isPuppySurface ? ${puppySubtitle} : ${idleSubtitle}`;

const clusterClass = one(
  header,
  /<div(?: data-agent-chat-header-region="actions")? className="(flex shrink-0 items-center gap-2)">/,
  "right-hand cluster class",
  WORKSPACE_PATH,
)[1];

const toggleAriaLabel = one(
  header,
  /ariaLabel="([^"]+)"/,
  "toggle group name",
  WORKSPACE_PATH,
)[1];

const toggleOptionsLiteral = one(
  header,
  /options=\{(\[[\s\S]*?\n\s*\])\}/,
  "toggle options",
  WORKSPACE_PATH,
)[1];

if (/[(`;]/.test(toggleOptionsLiteral)) {
  fail("a plain toggle-options literal", WORKSPACE_PATH);
}
// The options name lucide icons (`icon: Cloud`); bound here to their names,
// which the fixture renders as an icon-sized placeholder.
const toggleOptions = new Function(
  "Cloud",
  "Laptop",
  `"use strict"; return (${toggleOptionsLiteral});`,
)("Cloud", "Laptop") as Array<{
  value: string;
  label: string;
  icon?: string;
  accessibleLabel?: string;
}>;

const toggleIconClass = one(
  header,
  /<SegmentedControl[\s\S]*?iconClassName="([^"]*)"/,
  "toggle icon class",
  WORKSPACE_PATH,
)[1];

const toggleLabelClass = one(
  header,
  /<SegmentedControl[\s\S]*?labelClassName="([^"]*)"/,
  "toggle label class",
  WORKSPACE_PATH,
)[1];

const profileVariant = one(
  header,
  /<ShellActionSurface\s+variant="([^"]+)"\s+data-testid="profile-open-button"/,
  "profile button variant",
  WORKSPACE_PATH,
)[1];
const shellSurfacePath = "components/app-ui/shell-action-surface.tsx";
const profileClass = one(
  read(shellSurfacePath),
  new RegExp(`\\b${profileVariant}:\\s*"([^"]+)"`),
  "shared profile target class",
  shellSurfacePath,
)[1];
const profilePhotoClass = one(
  header,
  /data-testid="profile-open-button"[\s\S]*?<Avatar className="([^"]+)"/,
  "profile photo class",
  WORKSPACE_PATH,
)[1];

/**
 * The guard on the picker, and the order of the header's actions.
 *
 * The picker is gated on the surface: it must not exist on Puppy One's screen.
 * What keeps the toggle from sliding when it comes and goes is ORDER, not a
 * reserved slot: picker, toggle, profile, with the toggle anchored to the
 * profile button at the right edge, so the picker appears and leaves on the far
 * side of the toggle. The order is read from the source and the fixture renders
 * the actions in it, so a reorder that puts the picker between the toggle and
 * its anchor moves the toggle here as well, and the spec measures that.
 */
const pickerGateMatch = one(
  header,
  /\{\s*([^{}\n]+?)\s*\?\s*\(\s*<Select\b/,
  "the picker's own guard",
  WORKSPACE_PATH,
);

const triggerMatch = one(
  header,
  /<SelectTrigger\s+data-testid="([^"]+)"[\s\S]*?aria-label="([^"]+)"[\s\S]*?title=\{`([^`]+)`\}[\s\S]*?className="([^"]+)"/,
  "the cloud picker trigger",
  WORKSPACE_PATH,
);

const stripMatch = one(
  header,
  /\.replace\(\/([^/\n]+)\/([a-z]*),\s*"([^"]*)"\)/,
  "the model-label prefix strip",
  WORKSPACE_PATH,
);

const actionAnchors = {
  picker: header.indexOf("<Select\n"),
  toggle: header.indexOf("<SegmentedControl"),
  profile: header.indexOf('data-testid="profile-open-button"'),
};
if (Object.values(actionAnchors).some((at) => at < 0)) {
  fail("the header actions (picker, toggle, profile)", WORKSPACE_PATH);
}
const actionOrder = (
  Object.keys(actionAnchors) as Array<keyof typeof actionAnchors>
).sort((a, b) => actionAnchors[a] - actionAnchors[b]);

/**
 * The two `hidden` guards below the header, read from the whole file because
 * they live under it: One's transcript and One's composer. `hidden` is
 * display:none, so the surface that is not on screen leaves the accessibility
 * tree and the tab order while staying mounted, which is what keeps a cloud
 * turn in flight alive through a glance at Puppy. Both halves are assertions
 * the spec makes, and both need this expression to be the real one.
 *
 * The class is CAPTURED, not required to be `hidden`. Swap it for an
 * `opacity-0` that leaves the composer in the tab order and the fixture
 * renders that instead, so the browser reports a reachable composer under a
 * header that says "Puppy One" -- which is the defect -- rather than this file
 * throwing about an anchor it could not find.
 */
const oneHiddenMatches = [
  ...workspace.matchAll(/^\s*(isPuppySurface && "([^"]*)"),$/gm),
];
if (oneHiddenMatches.length !== 2) {
  fail(
    "both of One's off-screen guards (transcript and composer)",
    WORKSPACE_PATH,
  );
}
if (oneHiddenMatches[0][2] !== oneHiddenMatches[1][2]) {
  fail(
    "one shared off-screen class for One's transcript and composer " +
      `(found "${oneHiddenMatches[0][2]}" and "${oneHiddenMatches[1][2]}")`,
    WORKSPACE_PATH,
  );
}
const oneHiddenExpression = oneHiddenMatches[0][1];

/**
 * One's own composer, named so the spec can ask the accessibility tree for it
 * by the name a screen reader would hear rather than by a class.
 */
const oneComposerMatch = one(
  workspace,
  /<textarea\s+data-profile-composer="true"\s+ref=\{composerTextareaRef\}\s+data-testid=\{\s*composerExpanded\s*\?\s*"agent-chat-composer-expanded-textarea"\s*:\s*"(agent-chat-composer-textarea)"\s*\}\s*aria-label=\{composerExpanded\s*\?\s*"Expanded message One"\s*:\s*"([^"]+)"\}/,
  "One's composer textarea",
  WORKSPACE_PATH,
);

const puppyHiddenExpression = one(
  workspace,
  /className=\{cn\((!isPuppySurface && "[^"]*")/,
  "Puppy One's off-screen guard",
  WORKSPACE_PATH,
)[1];

const puppyMountedLazily = workspace.includes("{puppyEverOpened ? (");

// --- The Puppy surface's own controls -------------------------------------

const panel = read(PANEL_PATH);
const puppyPicker = read(PUPPY_PICKER_PATH);
const segmented = read(SEGMENTED_PATH);

const panelHeaderClass = one(
  panel,
  /<div className="(flex items-center gap-2 border-b[^"]+)">/,
  "the Puppy panel header row",
  PANEL_PATH,
)[1];

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
  panel,
  /\{onDevice \? "([^"]+)" : "([^"]+)"\}/,
  "the on-device pin labels",
  PANEL_PATH,
);

const puppyPickerMatch = one(
  puppyPicker,
  /className=\{cn\(\s*"([^"]+)",\s*className,\s*\)\}\s*title="([^"]+)"/,
  "the Puppy model picker trigger",
  PUPPY_PICKER_PATH,
);

const segmentedSmLiteral = one(
  segmented,
  /sm:\s*(\{[^}]*\}),/,
  "the small segmented-control sizing",
  SEGMENTED_PATH,
)[1];
if (/[(`;]/.test(segmentedSmLiteral)) {
  fail("a plain sizing literal", SEGMENTED_PATH);
}
const segmentedSm = new Function(
  `"use strict"; return (${segmentedSmLiteral});`,
)() as { container: string; segment: string; icon: string };

const toggleVariant = one(header, /<SegmentedControl[\s\S]*?variant="([^"]+)"/, "the authored toggle variant", WORKSPACE_PATH)[1];
if (toggleVariant !== "sliding") fail("the current sliding toggle projection", WORKSPACE_PATH);
const toggleFrameClass = one(header, /<NativeChatChrome kind="agent-surface"[\s\S]*?className="([^"]+)"/, "the authored toggle frame", WORKSPACE_PATH)[1];
const toggleClass = one(header, /<SegmentedControl[\s\S]*?\sclassName="([^"]+)"/, "the authored toggle classes", WORKSPACE_PATH)[1];
// Follow the selected family, not every string in its conditional. Including
// both compact and sliding sizing made this fixture measure a different tab.
const segmentedGroupBase = one(segmented, /role="radiogroup"[\s\S]*?className=\{cn\(\s*"([^"]+)"/, "the segmented group base", SEGMENTED_PATH)[1];
const segmentedSlidingGroup = one(segmented, /isSliding\s*\?\s*"([^"]+)"\s*:\s*"bg-black/, "the sliding group sizing", SEGMENTED_PATH)[1];

const segmentedSegmentBase = one(
  segmented,
  /\/\/ Base styles\s*"([^"]+)"/,
  "the segmented-control segment base classes",
  SEGMENTED_PATH,
)[1];
const segmentedSlidingGap = one(segmented, /isSliding \? "(gap-[^"]+)" :/, "the sliding segment gap", SEGMENTED_PATH)[1];
const segmentedSlidingSize = one(segmented, /isSliding \? "([^"]+)" : config\.segment/, "the sliding segment sizing", SEGMENTED_PATH)[1];
const segmentedMinimum = one(segmented, /minWidth: options\.length \* (\d+) \+ (\d+)/, "the sliding minimum hit measure", SEGMENTED_PATH);

// Keep the empty-chat geometry tied to the shipped welcome and scroll column.
const welcome = workspace.slice(workspace.indexOf("function AgentWelcomePanel("), workspace.indexOf("function useAnimatedAssistantText("));
const transcriptViewport = workspace.slice(workspace.indexOf("One's transcript region"), workspace.indexOf("ref={transcriptRef}"));
const transcript = workspace.slice(workspace.indexOf("ref={transcriptRef}"), workspace.indexOf("{visibleMessages.map"));
const transcriptClasses = one(transcript, /className=\{cn\(\s*"([^"]+)",\s*"([^"]+)"/, "transcript scroll classes", WORKSPACE_PATH);
const welcomeDescriptionLayout = one(
  welcome,
  /<p data-profile-role="header-description" className=\{cn\("([^"]+)",\s*CHAT_WELCOME_COPY_CLASSNAME\)\}/,
  "welcome description using shared chat typography",
  WORKSPACE_PATH,
)[1];
const chatStylesPath = "components/agent/chat-message-styles.tsx";
const welcomeDescriptionTypography = one(
  read(chatStylesPath),
  /export const CHAT_WELCOME_COPY_CLASSNAME\s*=\s*"([^"]+)";/,
  "shared welcome typography",
  chatStylesPath,
)[1];

export const AGENT_SURFACE_SOURCE = {
  welcome: {
    viewportClass: one(transcriptViewport, /"(relative min-h-0 flex-1 overflow-hidden)"/, "transcript viewport", WORKSPACE_PATH)[1],
    sectionClass: one(welcome, /<section className="([^"]+)"/, "welcome section", WORKSPACE_PATH)[1],
    columnClass: one(welcome, /<div className="([^"]+)"/, "welcome reading column", WORKSPACE_PATH)[1],
    headingClass: one(welcome, /<h2 data-profile-role="identity-name" className="([^"]+)"/, "welcome heading", WORKSPACE_PATH)[1],
    descriptionClass: `${welcomeDescriptionLayout} ${welcomeDescriptionTypography}`,
    scrollClass: `${transcriptClasses[1]} ${transcriptClasses[2]}`,
    transcriptColumnClass: one(transcript, /<div className="(mx-auto flex min-h-full [^"]+)"/, "transcript reading column", WORKSPACE_PATH)[1],
  },
  header: {
    historyClass,
    containerClass: headerContainerClass,
    centeredMarkerExpression: flatten(
      one(
        workspace,
        /data-one-centered-header=\{([^}]+)\}/,
        "One-only centered header marker",
        WORKSPACE_PATH,
      )[1],
    ),
    identityClass,
    brandTileClass,
    clusterClass,
    centered: {
      artwork: header.includes("<OnePresenceAvatar")
        ? {
            // Caller sizing owns the compact shell, not the Profile hero default.
            kind: "image",
            containerClass: one(
              read("components/agent/one-presence-avatar.tsx"),
              /data-one-presence-state=\{state\} className=\{`([^$]+)\$\{className/,
              "One presence surface classes",
              "components/agent/one-presence-avatar.tsx",
            )[1] + one(
              header,
              /<OnePresenceAvatar state=\{onePresenceState\} className="([^"]+)"/,
              "One presence sizing override",
              WORKSPACE_PATH,
            )[1],
            className: one(
              read("components/agent/one-presence-avatar.tsx"),
              /unoptimized loading="eager" decoding="async" className="([^"]+)"/,
              "One presence image sizing",
              "components/agent/one-presence-avatar.tsx",
            )[1],
          }
        : {
            kind: "image",
            containerClass: one(
              header,
              /<HushhMark[\s\S]*?className="([^"]+)"/,
              "One mark wrapper",
              WORKSPACE_PATH,
            )[1],
            className: one(
              header,
              /<HushhMark[\s\S]*?imageClassName="([^"]+)"/,
              "One mark image",
              WORKSPACE_PATH,
            )[1],
          },
      historyClass,
      surfaceClass: one(
        header,
        /<NativeChatChrome kind="agent-surface"[\s\S]*?className="([^"]+)"/,
        "native surface slot",
        WORKSPACE_PATH,
      )[1],
      profileTriggerClass: one(
        header,
        /data-agent-chat-one-profile-trigger[\s\S]*?className="([^"]+)"/,
        "One profile target",
        WORKSPACE_PATH,
      )[1],
    },
    /** Source order of the actions, e.g. ["picker", "toggle", "profile"]. */
    actionOrder,
    profileClass,
    profilePhotoClass,
    nameClass: nameMatch[1],
    /** `isPuppySurface ? "Puppy One" : "One"`, run by the fixture. */
    nameExpression: flatten(nameMatch[2]),
    subtitleClass,
    subtitleExpression,
  },
  toggle: {
    ariaLabel: toggleAriaLabel,
    options: toggleOptions,
    frameClass: toggleFrameClass,
    minimumWidth: toggleOptions.length * Number(segmentedMinimum[1]) + Number(segmentedMinimum[2]),
    containerClass: [segmentedGroupBase, segmentedSlidingGroup, toggleClass].join(" "),
    segmentClass: `${segmentedSegmentBase} ${segmentedSlidingGap} ${segmentedSlidingSize} flex-1`,
    iconClass: `${segmentedSm.icon} ${toggleIconClass}`,
    labelClass: `whitespace-nowrap ${toggleLabelClass}`,
  },
  cloudPicker: {
    /** The guard on the control itself. This is the reported defect's fix. */
    gateExpression: flatten(pickerGateMatch[1]),
    testId: triggerMatch[1],
    ariaLabel: triggerMatch[2],
    /** `Running ${modelPreference.effective_model}`, binding left in. */
    titleTemplate: triggerMatch[3],
    triggerClass: triggerMatch[4],
    iconClass: one(
      header,
      /<Cpu aria-hidden="true" className="([^"]+)"/,
      "phone model icon",
      WORKSPACE_PATH,
    )[1],
    labelStrip: {
      pattern: stripMatch[1],
      flags: stripMatch[2],
      replacement: stripMatch[3],
    },
  },
  visibility: {
    oneHiddenExpression,
    puppyHiddenExpression,
    puppyMountedLazily,
  },
  oneComposer: {
    testId: oneComposerMatch[1],
    ariaLabel: oneComposerMatch[2],
  },
  puppy: {
    panelHeaderClass,
    composerPlaceholder: puppyComposerPlaceholder,
    sendLabel: puppySendLabel,
    pinOnLabel: puppyPinLabels[1],
    pinOffLabel: puppyPinLabels[2],
    pickerClass: puppyPickerMatch[1],
    pickerTitle: puppyPickerMatch[2],
  },
} as const;
